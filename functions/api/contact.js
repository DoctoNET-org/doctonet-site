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
