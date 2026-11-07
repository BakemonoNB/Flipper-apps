// Boucle de conversation avec un modèle Ollama (gpt-oss) et appels d'outils.
// num_ctx doit rester celui du prospecteur (8192) : sinon Ollama charge une 2e copie du modèle en RAM.

const MAX_STEPS = 8; // tours modèle -> outils -> modèle, au plus

// messages : historique sans le message système (modifié sur place : la réponse y est ajoutée).
// onEvent({event:'text', text}) | onEvent({event:'tool', tool, args})
// callTool(name, args) -> Promise<{ok, result|error}>
export async function runOllama({ url, model, numCtx = 8192, think = 'low', systemPrompt, messages, text, tools,
  callTool, onEvent, timeoutMs = 300000 }) {
  messages.push({ role: 'user', content: text });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await fetch(url.replace(/\/$/, '') + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          tools,
          stream: true,
          think,
          options: { num_ctx: numCtx },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('Ollama a répondu ' + res.status + ' : ' + (await res.text()).slice(0, 300));

      let content = '';
      const toolCalls = [];
      const decoder = new TextDecoder();
      let buf = '';
      const handle = (line) => {
        if (!line.trim()) return;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error('Ollama : ' + ev.error);
        const m = ev.message || {};
        if (m.content) { content += m.content; onEvent({ event: 'text', text: m.content }); }
        if (Array.isArray(m.tool_calls)) toolCalls.push(...m.tool_calls);
      };
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      handle(buf);

      messages.push(toolCalls.length ? { role: 'assistant', content, tool_calls: toolCalls } : { role: 'assistant', content });
      if (!toolCalls.length) return;

      for (const call of toolCalls) {
        const name = call.function && call.function.name;
        let args = call.function && call.function.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        if (!args || typeof args !== 'object') args = {};
        onEvent({ event: 'tool', tool: name, args });
        let result;
        try { result = await callTool(name, args); } catch (e) { result = { ok: false, error: e.message }; }
        messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
      }
    }
    throw new Error('trop d\'appels d\'outils d\'affilée (' + MAX_STEPS + ')');
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('gpt-oss n\'a pas répondu en ' + Math.round(timeoutMs / 1000) + ' s');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
