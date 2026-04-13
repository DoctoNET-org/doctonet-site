/**
 * functions/find-professional.js
 * Cloudflare Pages Function — point d'entrée HTTP
 *
 * URL publique : https://www.doctonet.org/find-professional
 *
 * Paramètre GET attendu : ?location=<ville ou code postal>
 */

import { findProfessional } from "../lib/findProfessional.js";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "https://www.doctonet.org",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

export async function onRequest(context) {
  const { request } = context;

  // Gestion preflight CORS (appels navigateur)
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Seule la méthode GET est acceptée
  if (request.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: CORS_HEADERS }
    );
  }

  try {
    // 1. Lire le paramètre ?location=
    const url = new URL(request.url);
    const location = url.searchParams.get("location");

    // 2. Validation
    if (!location || location.trim() === "") {
      return new Response(
        JSON.stringify({ error: "Paramètre 'location' manquant ou vide." }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // 3. Logique métier
    const results = await findProfessional(location.trim());

    // 4. Réponse
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: CORS_HEADERS
    });

  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Erreur serveur",
        details: error.message
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
