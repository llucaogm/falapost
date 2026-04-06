const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido' }) };
  }

  try {
    const { igUrl, nicho, opts } = JSON.parse(event.body);

    if (!igUrl || !igUrl.includes('instagram.com')) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL do Instagram inválida.' }) };
    }

    const APIFY_TOKEN = process.env.APIFY_TOKEN;
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

    if (!APIFY_TOKEN || !ANTHROPIC_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chaves de API não configuradas.' }) };
    }

    // 1. Dispara o scraper de comentários no Apify
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-comment-scraper/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: [igUrl],
          resultsLimit: 200
        })
      }
    );

    if (!runRes.ok) {
      const err = await runRes.text();
      throw new Error('Erro ao iniciar scraper: ' + err);
    }

    const runData = await runRes.json();
    const runId = runData.data?.id;

    if (!runId) throw new Error('Não foi possível iniciar o scraper do Apify.');

    // 2. Aguarda o scraper terminar (polling a cada 3s, máximo 60s)
    let comments = [];
    let attempts = 0;
    while (attempts < 20) {
      await new Promise(r => setTimeout(r, 3000));
      attempts++;

      const statusRes = await fetch(
        `https://api.apify.com/v2/acts/apify~instagram-comment-scraper/runs/${runId}?token=${APIFY_TOKEN}`
      );
      const statusData = await statusRes.json();
      const status = statusData.data?.status;

      if (status === 'SUCCEEDED') {
        const datasetId = statusData.data?.defaultDatasetId;
        const itemsRes = await fetch(
          `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=200`
        );
        const items = await itemsRes.json();
        comments = items.map(i => i.text || i.ownerUsername + ': ' + i.text).filter(Boolean);
        break;
      }

      if (status === 'FAILED' || status === 'ABORTED') {
        throw new Error('O scraper falhou ao buscar os comentários.');
      }
    }

    if (comments.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ error: 'Nenhum comentário encontrado. O post pode ser privado ou sem comentários.' })
      };
    }

    // 3. Manda para o Claude analisar
    const optsDesc = [];
    if (opts.includes('ideias'))    optsDesc.push('"ideias": [{"titulo":"...","motivo":"..."}]');
    if (opts.includes('hooks'))     optsDesc.push('"hooks": [{"tipo":"ATENÇÃO|DOR|AUTORIDADE|CURIOSIDADE","texto":"...","dica":"..."}]');
    if (opts.includes('sentimento'))optsDesc.push('"sentimento": {"curioso":0-100,"frustrado":0-100,"admirado":0-100,"pedindo_mais":0-100,"temas":[{"tema":"...","quente":true/false}]}');
    if (opts.includes('roteiro'))   optsDesc.push('"roteiro": {"gancho":"...","contexto":"...","desenvolvimento":["...","...","..."],"virada":"...","cta_final":"..."}');
    if (opts.includes('cta'))       optsDesc.push('"cta": [{"tipo":"comentario|salvar|compartilhar","texto":"..."}]');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: `Você é o FalaPost, especialista em estratégia de conteúdo para criadores do Instagram brasileiros.
Analise os comentários reais e gere insights acionáveis.
Responda APENAS em JSON puro, sem markdown, sem texto fora do JSON.`,
        messages: [{
          role: 'user',
          content: `Nicho: ${nicho}

Comentários (${comments.length} extraídos automaticamente do Instagram):
${comments.slice(0, 200).join('\n')}

Gere JSON com estas chaves: ${opts.join(', ')}

Estrutura:
${optsDesc.join('\n')}

Responda APENAS com JSON puro.`
        }]
      })
    });

    if (!claudeRes.ok) {
      throw new Error('Erro ao chamar a IA.');
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content[0].text;
    const clean = rawText.replace(/```json|```/g, '').trim();
    const resultado = JSON.parse(clean);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ resultado, totalComentarios: comments.length })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Erro interno.' })
    };
  }
};
