/**
 * findProfessional.js — Logique métier principale
 *
 * Géocodage : API Adresse du gouvernement français
 *   https://api-adresse.data.gouv.fr
 *   → Gratuite, sans clé API, couvre toute la France
 *   → Accepte villes, codes postaux, adresses complètes
 *
 * Compatible : Cloudflare Workers, Node.js, Vercel, Netlify
 */

import { calculateDistanceKm } from "./geo.js";
import { professionals } from "./data.js";

const MAX_DISTANCE_KM = 30; // rayon de recherche en km
const MAX_RESULTS = 5;      // nombre maximum de résultats retournés

/**
 * Fonction principale
 * @param {string} locationInput - ville ou code postal saisi par l'utilisateur
 * @returns {Promise<Array>} liste des professionnels triés par distance
 */
export async function findProfessional(locationInput) {

  // 1. Nettoyer l'entrée utilisateur
  const location = locationInput.trim();
  if (!location) return [];

  // 2. Géocoder via l'API gouvernementale française
  const userCoords = await geocodeWithGouv(location);

  if (!userCoords) {
    // Lieu non reconnu par l'API
    return [];
  }

  // 3. Calculer la distance entre l'utilisateur et chaque professionnel
  const withDistance = professionals.map(pro => ({
    ...pro,
    distance_km: calculateDistanceKm(
      userCoords.lat,
      userCoords.lng,
      pro.lat,
      pro.lng
    )
  }));

  // 4. Filtrer, trier, limiter
  return withDistance
    .filter(p => p.distance_km <= MAX_DISTANCE_KM)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, MAX_RESULTS);
}

/**
 * Géocodage via api-adresse.data.gouv.fr
 * @param {string} location - texte libre (CP, ville, adresse)
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
async function geocodeWithGouv(location) {
  try {
    const url =
      `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(location)}&limit=1`;

    const response = await fetch(url);

    if (!response.ok) return null;

    const data = await response.json();

    if (!data.features || data.features.length === 0) return null;

    const [lng, lat] = data.features[0].geometry.coordinates;
    return { lat, lng };

  } catch {
    return null;
  }
}
