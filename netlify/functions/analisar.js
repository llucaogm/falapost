exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const HIKERAPI_KEY = process.env.HIKERAPI_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!HIKERAPI_KEY || !ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'APIs nao configuradas. Verifique HIKERAPI_KEY e ANTHROPIC_API_KEY no Netlify.' })
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
      // Extrair shortcode da URL (/p/XXXX/ ou /reel/XXXX/)
      const shortcodeMatch = igUrl.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
      if (!shortcodeMatch) {
        return { statusCode: 400, body: JSON.stringify({ error: 'URL invalida. Use o link de um post ou reel publico do Instagram. Ex: https://www.instagram.com/p/ABC123/' }) };
      }
      const code = shortcodeMatch[1];

      // Buscar comentarios usando v2 com paginacao
      let allComments = [];
      let endCursor = null;
      let page = 0;
      const maxPages = 5;

      while (page < maxPages) {
        const params = new URLSearchParams({ code });
        if (endCursor) params.append('end_cursor', endCursor);

        const res = await fetch(
          `https://api.hikerapi.com/v2/media/comments?${params.toString()}`,
          { headers: { 'x-access-key': HIKERAPI_KEY, 'accept': 'application/json' } }
        );

        if (!res.ok) {
          const err = await res.text();
          return { statusCode: 500, body: JSON.stringify({ error: `Erro HikerAPI: ${err}` }) };
        }

        const data = await res.json();

        // HikerAPI pode retornar em diferentes formatos
        const items = data.comments || data.data || data.items || (Array.isArray(data) ? data : []);

        if (!items || items.length === 0) break;

        allComments = allComments.concat(items);
        endCursor = data.end_cursor || data.next_cursor || data.next_max_id || null;
        if (!endCursor || allComments.length >= 150) break;
        page++;
      }

      if (allComments.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ error: 'Nenhum comentario encontrado. Verifique se o post e publico e tem comentarios.' }) };
      }

      totalComentarios = allComments.length;
      commentTexts = allComments
        .filter(c => c.text || c.content || c.comment)
        .map(c => c.text || c.content || c.comment)
        .slice(0, 150)
        .join('\n');

    } else if (manualText) {
      commentTexts = manualText;
      totalComentarios = manualText.split('\n').filter(l => l.trim()).length;
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Forneca a URL do post ou comentarios manuais.' }) };
    }

    // Montar JSON template baseado nas opcoes ativas
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

Retorne EXATAMENTE este JSON com os campos preenchidos com base nos comentarios (substitua todos os valores "string" e numeros por conteudo real em portugues):
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

    resultado = resultado.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const jsonMatch = resultado.match(/\{[\s\S]*\}/);
    if (jsonMatch) resultado = jsonMatch[0];

    let parsed;
    try {
      parsed = JSON.parse(resultado);
    } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Erro ao processar resposta da IA. Tente novamente.' }) };
    }

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
