import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./AuthGate";
import "./fonts.css";
import "./styles.css";
import "./agent.css";
import "./outreach.css";
import "./premium.css";
import "./auth.css";
import "./command-centre.css";
import "./atelier.css";
import "./intake.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>
);
