/**
 * Cloudflare Pages Function
 * URL finale : https://doctonet.org/find-professional
 *
 * Rôle :
 * - recevoir la requête HTTP
 * - valider les paramètres
 * - appeler la logique métier portable
 * - renvoyer la réponse JSON
 */

import { findProfessional } from "../lib/findProfessional.js";

export async function onRequest(context) {
  const { request } = context;

  try {
    // 1. Lire les paramètres de l'URL
    const url = new URL(request.url);
    const location = url.searchParams.get("location");

    // 2. Validation minimale
    if (!location || location.trim() === "") {
      return new Response(
        JSON.stringify({
          error: "Missing location parameter"
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    // 3. Appel de la logique métier PORTABLE
    const results = await findProfessional(location);

    // 4. Réponse JSON
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // optionnel : autoriser appel depuis le site
        "Access-Control-Allow-Origin": "*"
      }
    });

  } catch (error) {
    // 5. Gestion d'erreur propre
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error.message
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
}
