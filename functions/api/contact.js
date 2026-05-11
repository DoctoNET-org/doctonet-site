export async function onRequestPost(context) {
  const webhookUrl = context.env.MAKE_WEBHOOK_URL;

  if (!webhookUrl) {
    return new Response(JSON.stringify({ error: 'Configuration manquante' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Corps de requête invalide' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ── Validation serveur ──────────────────────────────────────────────────────
  const { PRENOM, NOM, EMAIL, MESSAGE } = body;

  if (!PRENOM?.trim() || !NOM?.trim() || !MESSAGE?.trim()) {
    return new Response(JSON.stringify({ error: 'Champs obligatoires manquants' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(EMAIL)) {
    return new Response(JSON.stringify({ error: 'Adresse email invalide' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (MESSAGE.length > 2000) {
    return new Response(JSON.stringify({ error: 'Message trop long (2000 caractères max)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  // ───────────────────────────────────────────────────────────────────────────

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  return new Response(response.body, {
    status: response.status,
    headers: { 'Content-Type': 'application/json' }
  });
}
