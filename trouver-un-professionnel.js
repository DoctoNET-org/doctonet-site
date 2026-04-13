/**
 * trouver-un-professionnel.js
 * Script côté navigateur — appelle la Cloudflare Function
 */

const searchBtn     = document.getElementById("searchBtn");
const locationInput = document.getElementById("location");
const resultsDiv    = document.getElementById("results");
const messageDiv    = document.getElementById("message");

searchBtn.addEventListener("click", async () => {
  const location = locationInput.value.trim();

  resultsDiv.innerHTML  = "";
  messageDiv.textContent = "";
  messageDiv.className  = "info";

  // Validation côté client
  if (!location) {
    messageDiv.textContent = "Veuillez saisir une ville ou un code postal.";
    messageDiv.className   = "error";
    return;
  }

  messageDiv.textContent = "Recherche en cours…";

  try {
    // ✅ URL corrigée : Cloudflare Functions répond sur /find-professional
    const response = await fetch(
      `/find-professional?location=${encodeURIComponent(location)}`
    );

    if (!response.ok) {
      throw new Error(`Erreur HTTP ${response.status}`);
    }

    const data = await response.json();

    messageDiv.textContent = "";

    // Cas : erreur retournée par le serveur
    if (data.error) {
      messageDiv.textContent = `Erreur : ${data.error}`;
      messageDiv.className   = "error";
      return;
    }

    // Cas : aucun résultat
    if (!Array.isArray(data) || data.length === 0) {
      messageDiv.textContent =
        "Aucun professionnel trouvé à proximité. Essayez un code postal voisin ou élargissez votre recherche.";
      return;
    }

    // Affichage des résultats
    data.forEach(pro => {
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML = `
        <strong>${escapeHtml(pro.name)}</strong><br/>
        ${escapeHtml(pro.specialty)}<br/>
        ${escapeHtml(pro.address)}<br/>
        📞 <a href="tel:${pro.phone.replace(/\s/g, '')}">${escapeHtml(pro.phone)}</a><br/>
        📍 À environ ${pro.distance_km.toFixed(1)} km
      `;
      resultsDiv.appendChild(div);
    });

  } catch (error) {
    messageDiv.textContent =
      "Une erreur est survenue. Merci de réessayer plus tard.";
    messageDiv.className = "error";
    console.error("[DoctoNET] Erreur recherche :", error);
  }
});

// Lancer la recherche avec la touche Entrée
locationInput.addEventListener("keydown", e => {
  if (e.key === "Enter") searchBtn.click();
});

// Sécurité : éviter les injections HTML
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
