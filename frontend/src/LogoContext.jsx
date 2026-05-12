import { createContext, useEffect, useState } from "react";
// VS brand override — see src/vs-theme/README.md.
// AnythingLLM's defaults are replaced by the VS marks. The
// fetchLogo() flow below is unchanged: a backend-configured custom
// logo still wins, so the firm can replace these defaults via the
// admin UI without further code change.
import AnythingLLM from "./vs-theme/vs-mark.svg";
import AnythingLLMDark from "./vs-theme/vs-mark-light.svg";
import DefaultLoginLogoLight from "./vs-theme/vs-login-logo.svg";
import DefaultLoginLogoDark from "./vs-theme/vs-login-logo.svg";
import System from "./models/system";

export const REFETCH_LOGO_EVENT = "refetch-logo";

function isLightMode() {
  return document.documentElement.getAttribute("data-theme") === "light";
}
export const LogoContext = createContext();

export function LogoProvider({ children }) {
  const [logo, setLogo] = useState("");
  const [loginLogo, setLoginLogo] = useState("");
  const [isCustomLogo, setIsCustomLogo] = useState(false);

  async function fetchInstanceLogo() {
    const DefaultLoginLogo = isLightMode()
      ? DefaultLoginLogoDark
      : DefaultLoginLogoLight;
    const DefaultSidebarLogo = isLightMode() ? AnythingLLMDark : AnythingLLM;
    try {
      // VS brand override — see src/vs-theme/README.md.
      // The backend `/api/system/logo` endpoint serves a default PNG
      // even when the firm has not uploaded a custom logo. Only honour
      // the backend URL when isCustomLogo is true; otherwise use the
      // VS mark so the upstream default never leaks through.
      const { isCustomLogo, logoURL } = await System.fetchLogo();
      if (isCustomLogo && logoURL) {
        setLogo(logoURL);
        setLoginLogo(logoURL);
        setIsCustomLogo(true);
      } else {
        setLogo(DefaultSidebarLogo);
        setLoginLogo(DefaultLoginLogo);
        setIsCustomLogo(false);
      }
    } catch (err) {
      setLogo(DefaultSidebarLogo);
      setLoginLogo(DefaultLoginLogo);
      setIsCustomLogo(false);
      console.error("Failed to fetch logo:", err);
    }
  }

  useEffect(() => {
    fetchInstanceLogo();
    window.addEventListener(REFETCH_LOGO_EVENT, fetchInstanceLogo);
    return () => {
      window.removeEventListener(REFETCH_LOGO_EVENT, fetchInstanceLogo);
    };
  }, []);

  return (
    <LogoContext.Provider value={{ logo, setLogo, loginLogo, isCustomLogo }}>
      {children}
    </LogoContext.Provider>
  );
}
