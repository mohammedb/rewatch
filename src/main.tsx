import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { UiProvider } from "./ui";
import "./app.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </React.StrictMode>,
);
