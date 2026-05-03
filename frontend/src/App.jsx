import React, { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { AuthProvider } from "@/AuthContext";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import i18n from "./i18n";

import { PfpProvider } from "./PfpContext";
import { LogoProvider } from "./LogoContext";
import { FullScreenLoader } from "./components/Preloader";
import { ThemeProvider } from "./ThemeContext";
import { PWAModeProvider } from "./PWAContext";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import ImageLightbox from "@/components/ImageLightbox";
import { ErrorBoundary } from "react-error-boundary";
import ErrorBoundaryFallback from "./components/ErrorBoundaryFallback";
// vs-fork Plan 1.5 frontend Tasks 8 + 8.5: idle-timeout watcher
// and step-up modal share a single window.fetch wrapper installed
// once at app boot.
import MfaInterceptor from "@/components/MfaInterceptor";

export default function App() {
  const location = useLocation();
  return (
    <ErrorBoundary
      FallbackComponent={ErrorBoundaryFallback}
      onError={console.error}
      resetKeys={[location.pathname]}
    >
      <ThemeProvider>
        <PWAModeProvider>
          <Suspense fallback={<FullScreenLoader />}>
            <AuthProvider>
              <LogoProvider>
                <PfpProvider>
                  <I18nextProvider i18n={i18n}>
                    <MfaInterceptor />
                    <Outlet />
                    <ToastContainer />
                    <KeyboardShortcutsHelp />
                    <ImageLightbox />
                  </I18nextProvider>
                </PfpProvider>
              </LogoProvider>
            </AuthProvider>
          </Suspense>
        </PWAModeProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
