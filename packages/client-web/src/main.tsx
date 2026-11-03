import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { client } from "./client.ts";
import { App } from "./App.tsx";
import { refreshColors } from "./theme.ts";
import "./index.css";

// the color pickers show what the stylesheet resolves to, so read it now that it is in
refreshColors();

// The client lives outside React, so StrictMode's double effects can't open a second socket or mic.
client.connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
