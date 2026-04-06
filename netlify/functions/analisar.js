exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!APIFY_TOKEN || !ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'APIs não configuradas. Verifique as variáveis de ambiente no Netlify.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  const { postUrl, nicho, opcoes } = body;

  if (!postUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: 'URL do post é obrigatória' }) };
  }

  try {
    // 1. Buscar comentários via Apify
    const apifyResponse = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-comment-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=60`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: [postUrl],
          resultsLimit: 200
        })
      }
    );

    if (!apifyResponse.ok) {
      const errText = await apifyResponse.text();
      return { statusCode: 500, body: JSON.stringify({ error: `Erro no Apify: ${errText}` }) };
    }

    const comments = await apifyResponse.json();

    if (!comments || comments.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ error: 'Nenhum comentário encontrado neste post. Verifique se a URL está correta e o post é público.' }) };
    }

    const commentTexts = comments
      .filter(c => c.text)
      .map(c => c.text)
      .slice(0, 200)
      .join('\n');

    // 2. Analisar com Claude
    const opcoesTexto = opcoes && opcoes.length > 0 ? opcoes.join(', ') : 'ideias de vídeo, hooks, análise de sentimento, roteiro, CTAs';

    const prompt = `Você é um especialista em criação de conteúdo para Instagram e YouTube. Analise os comentários abaixo de um post de Instagram e gere o seguinte: ${opcoesTexto}.

Nicho do criador: ${nicho || 'geral'}

COMENTÁRIOS:
${commentTexts}

Responda em português, de forma estruturada com seções claras para cada item solicitado. Seja criativo, específico e baseie tudo nos temas e dores reais dos comentários.`;

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      return { statusCode: 500, body: JSON.stringify({ error: `Erro na API Claude: ${errText}` }) };
    }

    const claudeData = await claudeResponse.json();
    const resultado = claudeData.content[0].text;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resultado,
        totalComentarios: comments.length,
        comentariosAnalisados: Math.min(comments.length, 200)
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Erro interno: ${err.message}` })
    };
  }
};
