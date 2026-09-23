import React from "react";
import ReactDOM from "react-dom/client";
import CustomerHub, { applyCatalogFromSupabase } from "./CustomerHub.jsx";
import { fetchCatalogFromSupabase } from "./supabaseCatalog.js";

const root = ReactDOM.createRoot(document.getElementById("root"));

function renderApp() {
  root.render(
    <React.StrictMode>
      <CustomerHub />
    </React.StrictMode>
  );
}

// Antes de dibujar la app por primera vez, intentamos traer el catálogo
// real de Supabase (modelos, sabores, recompensas). Si algo falla (sin
// internet, tablas vacías todavía), la app arranca de todas formas con el
// catálogo de ejemplo, para que nunca se quede en blanco.
fetchCatalogFromSupabase()
  .then((data) => {
    if (data) applyCatalogFromSupabase(data.models, data.rewards);
  })
  .finally(renderApp);
