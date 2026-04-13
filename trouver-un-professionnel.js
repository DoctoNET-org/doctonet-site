const searchBtn = document.getElementById("searchBtn");
const locationInput = document.getElementById("location");
const resultsDiv = document.getElementById("results");
const messageDiv = document.getElementById("message");

searchBtn.addEventListener("click", async () => {
  const location = locationInput.value.trim();

  resultsDiv.innerHTML = "";
  messageDiv.textContent = "";

  if (!location) {
    messageDiv.textContent = "Veuillez saisir une ville ou un code postal.";
    messageDiv.className = "error";
    return;
  }

  messageDiv.textContent = "Recherche en cours…";

  try {
    const response = await fetch(
      `/find-professional?location=${encodeURIComponent(location)}`
    );

    const data = await response.json();

    messageDiv.textContent = "";

    if (data.length === 0) {
      messageDiv.textContent =
        "Aucun professionnel trouvé à proximité pour ce lieu.";
      return;
    }

    data.forEach(pro => {
      const div = document.createElement("div");
      div.className = "card";

      div.innerHTML = `
        <strong>${pro.name}</strong><br />
        ${pro.specialty}<br />
        ${pro.address}<br />
        📞 ${pro.phone}<br />
        📍 À environ ${pro.distance_km.toFixed(1)} km
      `;

      resultsDiv.appendChild(div);
    });

  } catch (error) {
    messageDiv.textContent =
      "Une erreur est survenue. Merci de réessayer plus tard.";
    messageDiv.className = "error";
  }
});
