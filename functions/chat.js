export async function onRequestPost(context) {
  const { request, env } = context;
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-bridge-timestamp, x-bridge-signature',
    'Content-Type': 'application/json',
  };

  try {
    const timestamp = request.headers.get('x-bridge-timestamp');
    const signature = request.headers.get('x-bridge-signature');
    const body = await request.text();

    if (!timestamp || !signature) {
      return new Response(JSON.stringify({ error: 'Missing auth headers' }), { status: 401, headers: corsHeaders });
    }

    const apiKeys = (env.AGENTROUTER_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    let apiKey = '';
    let authed = false;

    for (const key of apiKeys) {
      const encoder = new TextEncoder();
      const keyData = encoder.encode(key);
      const msgData = encoder.encode(timestamp + '.' + body);
      const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
      const expected = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      if (expected === signature) { authed = true; apiKey = key; break; }
    }

    if (!authed) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401, headers: corsHeaders });
    }

    const { model, messages, system, max_tokens } = JSON.parse(body);
    const target = model || 'gpt-6-astra';
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: String(system).slice(0, 18000) });
    for (const m of (messages || [])) {
      if (m.content) msgs.push({ role: m.role || 'user', content: String(m.content).slice(0, 8000) });
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'User-Agent': 'opencode/1.25.0',
    };

    const arRes = await fetch('https://agentrouter.org/v1/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: target, messages: msgs, max_tokens: max_tokens || 2048, temperature: 0.7 }),
    });
    
    const data = await arRes.json().catch(() => ({}));
    const errMsg = data?.error?.message || '';
    
    if (!arRes.ok && errMsg.includes('/v1/responses')) {
      const res2 = await fetch('https://agentrouter.org/v1/responses', {
        method: 'POST', headers,
        body: JSON.stringify({
          model: target,
          input: msgs.map(m => ({ role: m.role, content: m.content })),
          max_output_tokens: max_tokens || 2048,
        }),
      });
      const data2 = await res2.json().catch(() => ({}));
      let text = '';
      if (Array.isArray(data2?.output)) {
        for (const item of data2.output) {
          if (item?.type === 'message' && Array.isArray(item?.content)) {
            for (const c of item.content) {
              if (c?.type === 'output_text' && c?.text) text += c.text;
            }
          }
        }
      }
      text = text.trim();
      if (text) return new Response(JSON.stringify({ response: text }), { headers: corsHeaders });
      return new Response(JSON.stringify({ error: 'No text in responses' }), { status: 502, headers: corsHeaders });
    }
    
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    if (text) return new Response(JSON.stringify({ response: text }), { headers: corsHeaders });
    return new Response(JSON.stringify({ error: errMsg || 'No text' }), { status: 502, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-bridge-timestamp, x-bridge-signature',
    }
  });
}
