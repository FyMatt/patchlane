import React from "react";
import { createRoot } from "react-dom/client";
import { CodeAgentApp } from "./components";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found.");
}

createRoot(root).render(
  <React.StrictMode>
    <CodeAgentApp />
  </React.StrictMode>
);
