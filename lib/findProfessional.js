/**
 * Logique métier indépendante de Cloudflare
 * Peut être utilisée sur :
 * - Cloudflare
 * - Vercel
 * - Netlify
 * - AWS Lambda
 * - Node.js
 */

import { calculateDistanceKm } from "./geo.js";
import { professionals } from "./data.js";

const MAX_DISTANCE_KM = 10;
const MAX_RESULTS = 5;

export async function findProfessional(locationInput) {
  // 1. Nettoyer et normaliser l'entrée utilisateur
  const location = normalizeLocation(locationInput);

  // 2. Convertir le lieu en coordonnées GPS
  const userCoordinates = geocodeLocation(location);
  if (!userCoordinates) {
    return [];
  }

  // 3. Calculer les distances
  const matches = professionals.map(pro => {
    const distance = calculateDistanceKm(
      userCoordinates.lat,
      userCoordinates.lng,
      pro.lat,
      pro.lng
    );

    return {
      ...pro,
      distance_km: distance
    };
  });

  // 4. Filtrer par rayon
  const nearby = matches
    .filter(p => p.distance_km <= MAX_DISTANCE_KM)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, MAX_RESULTS);

  return nearby;
}

/**
 * Normalisation simple de l'entrée
 */
function normalizeLocation(input) {
  return input.trim().toLowerCase();
}

/**
 * Géocodage SIMPLIFIÉ
 * (à remplacer plus tard par une API si besoin)
 */
function geocodeLocation(location) {
  // Exemple: correspondance directe CP → coordonnées
  const knownLocations = {
    "75017": { lat: 48.8843, lng: 2.3222 },
    "75018": { lat: 48.8925, lng: 2.3444 },
    "paris": { lat: 48.8566, lng: 2.3522 }
  };

  return knownLocations[location] || null;
}
