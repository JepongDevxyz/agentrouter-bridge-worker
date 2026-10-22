// AgentRouter Bridge - Cloudflare Worker
// Deploy: wrangler deploy or copy-paste in Cloudflare dashboard
// Env var: AGENTROUTER_API_KEYS (comma-separated)

export default {
  async fetch(request, env) {
    // CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-bridge-timestamp, x-bridge-signature',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/chat') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      const timestamp = request.headers.get('x-bridge-timestamp');
      const signature = request.headers.get('x-bridge-signature');
      const body = await request.text();

      if (!timestamp || !signature) {
        return new Response(JSON.stringify({ error: 'Missing auth headers' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Verify HMAC signature
      const apiKeys = (env.AGENTROUTER_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
      let authed = false;
      let apiKey = '';

      for (const key of apiKeys) {
        const encoder = new TextEncoder();
        const keyData = encoder.encode(key);
        const msgData = encoder.encode(timestamp + '.' + body);
        
        const cryptoKey = await crypto.subtle.importKey(
          'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
        const expected = Array.from(new Uint8Array(sigBuffer))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        
        if (expected === signature) {
          authed = true;
          apiKey = key;
          break;
        }
      }

      if (!authed) {
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Parse request
      const { model, messages, system, max_tokens } = JSON.parse(body);
      
      // Call AgentRouter
      const target = model || 'gpt-6-astra';
      const msgs = [];
      if (system) msgs.push({ role: 'system', content: String(system).slice(0, 18000) });
      for (const m of (messages || [])) {
        if (m.content) msgs.push({ role: m.role || 'user', content: String(m.content).slice(0, 8000) });
      }

      // Try chat completions first
      let result = await callChatCompletions(apiKey, target, msgs, max_tokens);
      
      // If it says to use /v1/responses, try that
      if (!result.ok && result.useResponses) {
        result = await callResponses(apiKey, target, msgs, max_tokens);
      }

      if (result.ok) {
        return new Response(JSON.stringify({ response: result.text }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } else {
        return new Response(JSON.stringify({ error: result.error }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

async function callChatCompletions(apiKey, model, messages, maxTokens) {
  try {
    const res = await fetch('https://agentrouter.org/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'User-Agent': 'opencode/1.25.0',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens || 2048,
        temperature: 0.7,
      }),
    });
    
    const data = await res.json().catch(() => ({}));
    const errMsg = data?.error?.message || '';
    
    if (errMsg.includes('/v1/responses')) {
      return { ok: false, useResponses: true };
    }
    
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    if (text) return { ok: true, text };
    return { ok: false, error: errMsg || 'No text' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function callResponses(apiKey, model, messages, maxTokens) {
  try {
    const res = await fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'User-Agent': 'opencode/1.25.0',
      },
      body: JSON.stringify({
        model,
        input: messages.map(m => ({ role: m.role, content: m.content })),
        max_output_tokens: maxTokens || 2048,
      }),
    });
    
    const data = await res.json().catch(() => ({}));
    let text = '';
    
    if (Array.isArray(data?.output)) {
      for (const item of data.output) {
        if (item?.type === 'message' && Array.isArray(item?.content)) {
          for (const c of item.content) {
            if (c?.type === 'output_text' && c?.text) text += c.text;
          }
        }
      }
    }
    
    text = text.trim();
    if (text) return { ok: true, text };
    return { ok: false, error: 'No text in responses' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
