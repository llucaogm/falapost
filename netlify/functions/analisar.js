exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!APIFY_TOKEN || !ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'APIs nao configuradas. Verifique as variaveis de ambiente no Netlify.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body invalido' }) };
  }

  const { igUrl, manualText, nicho, opts } = body;

  try {
    let commentTexts = '';
    let totalComentarios = 0;

    if (igUrl && igUrl.includes('instagram.com')) {
      // Apify run-sync pode demorar: usando run + polling para nao estourar timeout
      const runRes = await fetch(
        `https://api.apify.com/v2/acts/apify~instagram-comment-scraper/runs?token=${APIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ directUrls: [igUrl], resultsLimit: 200 })
        }
      );

      if (!runRes.ok) {
        const errText = await runRes.text();
        return { statusCode: 500, body: JSON.stringify({ error: `Erro ao iniciar Apify: ${errText}` }) };
      }

      const runData = await runRes.json();
      const runId = runData.data && runData.data.id;

      if (!runId) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Nao foi possivel iniciar a coleta de comentarios.' }) };
      }

      // Polling ate o run terminar (max ~55s para nao estourar o timeout do Netlify de 26s no plano free)
      // Netlify free tem 10s, plano pago tem 26s. Usar run-sync-get-dataset-items e melhor.
      const syncRes = await fetch(
        `https://api.apify.com/v2/acts/apify~instagram-comment-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=25&memory=256`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ directUrls: [igUrl], resultsLimit: 100 })
        }
      );

      if (!syncRes.ok) {
        const errText = await syncRes.text();
        return { statusCode: 500, body: JSON.stringify({ error: `Erro no Apify: ${errText}` }) };
      }

      const comments = await syncRes.json();

      if (!comments || comments.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ error: 'Nenhum comentario encontrado. Verifique se a URL esta correta e o post e publico.' }) };
      }

      totalComentarios = comments.length;
      commentTexts = comments.filter(c => c.text).map(c => c.text).slice(0, 100).join('\n');

    } else if (manualText) {
      commentTexts = manualText;
      totalComentarios = manualText.split('\n').filter(l => l.trim()).length;
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Forneca a URL do post ou comentarios manuais.' }) };
    }

    // Montar prompt dinamico baseado nas opcoes selecionadas
    const optsAtivos = Array.isArray(opts) && opts.length > 0 ? opts : ['ideias', 'hooks', 'sentimento', 'roteiro', 'cta'];

    const jsonTemplate = {};
    if (optsAtivos.includes('ideias')) jsonTemplate.ideias = [{"titulo":"string","motivo":"string"},{"titulo":"string","motivo":"string"},{"titulo":"string","motivo":"string"},{"titulo":"string","motivo":"string"},{"titulo":"string","motivo":"string"}];
    if (optsAtivos.includes('hooks')) jsonTemplate.hooks = [{"tipo":"ATENCAO","texto":"string","dica":"string"},{"tipo":"DOR","texto":"string","dica":"string"},{"tipo":"CURIOSIDADE","texto":"string","dica":"string"}];
    if (optsAtivos.includes('sentimento')) jsonTemplate.sentimento = {"curioso":30,"frustrado":20,"admirado":30,"pedindomais":20,"temas":[{"tema":"string","quente":true},{"tema":"string","quente":false}]};
    if (optsAtivos.includes('roteiro')) jsonTemplate.roteiro = {"gancho":"string","contexto":"string","desenvolvimento":["string","string","string"],"virada":"string","ctafinal":"string"};
    if (optsAtivos.includes('cta')) jsonTemplate.cta = [{"tipo":"comentario","texto":"string"},{"tipo":"salvar","texto":"string"},{"tipo":"compartilhar","texto":"string"}];

    const prompt = `Voce e um especialista em criacao de conteudo para Instagram. Analise os comentarios abaixo e retorne APENAS um objeto JSON valido, sem nenhum texto antes ou depois, sem markdown, sem explicacoes.

Nicho do criador: ${nicho || 'geral'}

COMENTARIOS:
${commentTexts}

Retorne EXATAMENTE este JSON com os campos preenchidos com base nos comentarios (substitua todos os valores "string" e numeros por conteudo real):
${JSON.stringify(jsonTemplate)}`;

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
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

    // Limpar markdown se vier
    resultado = resultado.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    // Extrair JSON mesmo se vier com texto ao redor
    const jsonMatch = resultado.match(/\{[\s\S]*\}/);
    if (jsonMatch) resultado = jsonMatch[0];

    let parsed;
    try {
      parsed = JSON.parse(resultado);
    } catch(e) {
      return { 
        statusCode: 500, 
        body: JSON.stringify({ error: `Erro ao processar resposta da IA: ${e.message}. Tente novamente.` }) 
      };
    }

    // Garantir que todos os campos existam mesmo que a IA nao retorne algum
    parsed.ideias = parsed.ideias || [];
    parsed.hooks = parsed.hooks || [];
    parsed.sentimento = parsed.sentimento || { curioso: 0, frustrado: 0, admirado: 0, pedindomais: 0, temas: [] };
    parsed.sentimento.temas = parsed.sentimento.temas || [];
    parsed.roteiro = parsed.roteiro || {};
    parsed.roteiro.desenvolvimento = parsed.roteiro.desenvolvimento || [];
    parsed.cta = parsed.cta || [];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...parsed, totalComentarios })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Erro interno: ${err.message}` }) };
  }
};
