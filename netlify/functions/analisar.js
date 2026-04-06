exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const HIKERAPI_KEY = process.env.HIKERAPI_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!HIKERAPI_KEY || !ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'APIs nao configuradas.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Body invalido' }) }; }

  const { igUrl, manualText, nicho, opts } = body;

  try {
    let commentTexts = '';
    let totalComentarios = 0;

    if (igUrl && igUrl.includes('instagram.com')) {

      const match = igUrl.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
      if (!match) {
        return { statusCode: 400, body: JSON.stringify({ error: 'URL invalida. Use o link direto de um post ou reel. Ex: https://www.instagram.com/reel/ABC123/' }) };
      }
      const code = match[1];

      // PASSO 1: shortcode -> media_id
      const pkRes = await fetch(
        `https://api.hikerapi.com/v1/media/pk/from/code?code=${code}`,
        { headers: { 'x-access-key': HIKERAPI_KEY, 'accept': 'application/json' } }
      );
      const pkRaw = await pkRes.text();
      if (!pkRes.ok) {
        return { statusCode: 500, body: JSON.stringify({ error: `Erro ao buscar post: ${pkRaw}` }) };
      }

      let mediaId;
      try {
        const parsed = JSON.parse(pkRaw);
        mediaId = typeof parsed === 'object' && parsed !== null
          ? String(parsed.pk || parsed.id || parsed.media_id || parsed.media_pk || '')
          : String(parsed);
      } catch {
        mediaId = pkRaw.replace(/[^0-9]/g, '');
      }
      mediaId = mediaId.replace(/[^0-9]/g, '').trim();

      if (!mediaId) {
        return { statusCode: 500, body: JSON.stringify({ error: `Nao foi possivel obter ID do post. Resposta: ${pkRaw}` }) };
      }

      // PASSO 2: buscar comentarios com paginacao
      let allComments = [];
      let pageId = null;
      let page = 0;
      const maxPages = 6;

      while (page < maxPages) {
        const params = new URLSearchParams({ id: mediaId });
        if (pageId) params.append('page_id', pageId);

        const commRes = await fetch(
          `https://api.hikerapi.com/v2/media/comments?${params.toString()}`,
          { headers: { 'x-access-key': HIKERAPI_KEY, 'accept': 'application/json' } }
        );

        const commRaw = await commRes.text();
        if (!commRes.ok) {
          return { statusCode: 500, body: JSON.stringify({ error: `Erro comentarios: ${commRaw}` }) };
        }

        let commData;
        try { commData = JSON.parse(commRaw); } catch { break; }

        // HikerAPI v2 retorna { response: { comments: [...], preview_comments: [...] } }
        // ou pode retornar direto array ou objeto com comments no nivel raiz
        let items = [];
        const inner = commData.response || commData;

        if (Array.isArray(commData)) {
          items = commData;
        } else if (Array.isArray(inner)) {
          items = inner;
        } else {
          items = inner.comments || inner.preview_comments || inner.items || inner.data || inner.results || [];
        }

        if (!items || items.length === 0) break;

        allComments = allComments.concat(items);

        // cursor de proxima pagina
        const src = commData.response || commData;
        pageId = src.next_min_id || src.next_max_id || src.next_cursor || src.page_id || src.next_page_id || null;
        if (!pageId || allComments.length >= 90) break;
        page++;
      }

      if (allComments.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ error: 'Nenhum comentario encontrado. O post pode ser privado ou nao ter comentarios.' }) };
      }

      totalComentarios = allComments.length;
      commentTexts = allComments
        .filter(c => c && (c.text || c.content || c.comment_text || c.comment))
        .map(c => c.text || c.content || c.comment_text || c.comment)
        .slice(0, 120)
        .join('\n');

    } else if (manualText) {
      commentTexts = manualText;
      totalComentarios = manualText.split('\n').filter(l => l.trim()).length;
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Forneca a URL do post ou cole os comentarios manualmente.' }) };
    }

    const optsAtivos = Array.isArray(opts) && opts.length > 0 ? opts : ['ideias', 'hooks', 'sentimento', 'roteiro', 'cta'];
    const jsonTemplate = {};
    if (optsAtivos.includes('ideias'))     jsonTemplate.ideias     = [{"titulo":"string","motivo":"string"},{"titulo":"string","motivo":"string"},{"titulo":"string","motivo":"string"},{"titulo":"string","motivo":"string"},{"titulo":"string","motivo":"string"}];
    if (optsAtivos.includes('hooks'))      jsonTemplate.hooks      = [{"tipo":"ATENCAO","texto":"string","dica":"string"},{"tipo":"DOR","texto":"string","dica":"string"},{"tipo":"CURIOSIDADE","texto":"string","dica":"string"}];
    if (optsAtivos.includes('sentimento')) jsonTemplate.sentimento = {"curioso":30,"frustrado":20,"admirado":30,"pedindomais":20,"temas":[{"tema":"string","quente":true},{"tema":"string","quente":false}]};
    if (optsAtivos.includes('roteiro'))    jsonTemplate.roteiro    = {"gancho":"string","contexto":"string","desenvolvimento":["string","string","string"],"virada":"string","ctafinal":"string"};
    if (optsAtivos.includes('cta'))        jsonTemplate.cta        = [{"tipo":"comentario","texto":"string"},{"tipo":"salvar","texto":"string"},{"tipo":"compartilhar","texto":"string"}];

    const prompt = `Voce e um especialista em criacao de conteudo para Instagram. Analise os comentarios abaixo e retorne APENAS um objeto JSON valido, sem nenhum texto antes ou depois, sem markdown, sem explicacoes.

Nicho do criador: ${nicho || 'geral'}

COMENTARIOS:
${commentTexts}

Retorne EXATAMENTE este JSON preenchido em portugues com base nos comentarios:
${JSON.stringify(jsonTemplate)}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
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

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return { statusCode: 500, body: JSON.stringify({ error: `Erro na API Claude: ${err}` }) };
    }

    const claudeData = await claudeRes.json();
    let resultado = claudeData.content[0].text.trim();
    resultado = resultado.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const jsonMatch = resultado.match(/\{[\s\S]*\}/);
    if (jsonMatch) resultado = jsonMatch[0];

    let parsed;
    try { parsed = JSON.parse(resultado); }
    catch { return { statusCode: 500, body: JSON.stringify({ error: 'Erro ao processar resposta da IA. Tente novamente.' }) }; }

    parsed.ideias                  = parsed.ideias || [];
    parsed.hooks                   = parsed.hooks || [];
    parsed.sentimento              = parsed.sentimento || { curioso: 0, frustrado: 0, admirado: 0, pedindomais: 0, temas: [] };
    parsed.sentimento.temas        = parsed.sentimento.temas || [];
    parsed.roteiro                 = parsed.roteiro || {};
    parsed.roteiro.desenvolvimento = parsed.roteiro.desenvolvimento || [];
    parsed.cta                     = parsed.cta || [];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...parsed, totalComentarios })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Erro interno: ${err.message}` }) };
  }
};
