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

  const { igUrl, manualText, nicho, opts } = body;

  try {
    let commentTexts = '';
    let totalComentarios = 0;

    if (igUrl && igUrl.includes('instagram.com')) {
      const apifyResponse = await fetch(
        `https://api.apify.com/v2/acts/apify~instagram-comment-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=60`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ directUrls: [igUrl], resultsLimit: 200 })
        }
      );

      if (!apifyResponse.ok) {
        const errText = await apifyResponse.text();
        return { statusCode: 500, body: JSON.stringify({ error: `Erro no Apify: ${errText}` }) };
      }

      const comments = await apifyResponse.json();

      if (!comments || comments.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ error: 'Nenhum comentário encontrado. Verifique se a URL está correta e o post é público.' }) };
      }

      totalComentarios = comments.length;
      commentTexts = comments.filter(c => c.text).map(c => c.text).slice(0, 200).join('\n');

    } else if (manualText) {
      commentTexts = manualText;
      totalComentarios = manualText.split('\n').filter(l => l.trim()).length;
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Forneça a URL do post ou comentários manuais.' }) };
    }

    const opcoesTexto = opts && opts.length > 0 ? opts.join(', ') : 'ideias, hooks, sentimento, roteiro, cta';

    const prompt = `Você é especialista em criação de conteúdo. Analise os comentários e responda SOMENTE em JSON válido, sem texto fora do JSON.

Nicho: ${nicho || 'geral'}
Gerar: ${opcoesTexto}

COMENTÁRIOS:
${commentTexts}

Responda EXATAMENTE neste formato JSON:
{
  "ideias": [{"titulo": "Título", "motivo": "Motivo"}],
  "hooks": [{"tipo": "ATENÇÃO", "texto": "Texto do hook", "dica": "Dica"}],
  "sentimento": {
    "curioso": 40, "frustrado": 20, "admirado": 25, "pedindomais": 15,
    "temas": [{"tema": "Tema", "quente": true}]
  },
  "roteiro": {
    "gancho": "Primeiros 3 segundos",
    "contexto": "Apresentação do problema",
    "desenvolvimento": ["Ponto 1", "Ponto 2", "Ponto 3"],
    "virada": "Momento de revelação",
    "ctafinal": "Chamada para ação"
  },
  "cta": [{"tipo": "comentario", "texto": "Texto do CTA"}]
}`;

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      return { statusCode: 500, body: JSON.stringify({ error: `Erro na API Claude: ${errText}` }) };
    }

    const claudeData = await claudeResponse.json();
    let resultado = claudeData.content[0].text.trim();
    resultado = resultado.replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '');

    let parsed;
    try {
      parsed = JSON.parse(resultado);
    } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Erro ao processar resposta da IA. Tente novamente.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...parsed, totalComentarios })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Erro interno: ${err.message}` }) };
  }
};
