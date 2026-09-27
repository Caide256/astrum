import { Component, type ReactNode } from "react";

import { t } from "../i18n/index.ts";

/**
 * Keeps a rendering error inside one piece of the screen. A single message
 * that trips the renderer shows a short note instead of taking the whole
 * window down with it.
 */
export class Guard extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("render failed", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return this.props.fallback ?? <div className="guard-note">{t("guard.part")}</div>;
  }
}

/** The last line of defence: the app shows a way back instead of an empty window. */
export function AppGuard({ children }: { children: ReactNode }) {
  return (
    <Guard
      fallback={
        <div className="guard-screen">
          <h2>{t("guard.title")}</h2>
          <p>{t("guard.text")}</p>
          <button className="primary" onClick={() => location.reload()}>
            {t("guard.reload")}
          </button>
        </div>
      }
    >
      {children}
    </Guard>
  );
}
