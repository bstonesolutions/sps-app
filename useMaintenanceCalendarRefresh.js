import { useEffect, useRef } from "react";
import { createMaintenanceRefreshController } from "./maintenanceCalendarRefresh.js";

export default function useMaintenanceCalendarRefresh({ active, connected, refresh }) {
  const currentRefresh = useRef(refresh);
  const controllerRef = useRef(null);
  currentRefresh.current = refresh;
  // Keep the same throttle and in-flight request when changing invoice tabs.
  // A stopped controller is discarded only when this screen unmounts.
  useEffect(() => {
    const controller = createMaintenanceRefreshController({ refresh: () => currentRefresh.current() });
    controllerRef.current = controller;
    return () => {
      controller.stop();
      controllerRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (!active || !connected) return;
    const controller = controllerRef.current;
    const requestWhenVisible = () => {
      if (document.visibilityState !== "hidden") void controller.request().catch(() => {});
    };
    requestWhenVisible();
    window.addEventListener("focus", requestWhenVisible);
    document.addEventListener("visibilitychange", requestWhenVisible);
    const timer = window.setInterval(requestWhenVisible, 5 * 60_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", requestWhenVisible);
      document.removeEventListener("visibilitychange", requestWhenVisible);
    };
  }, [active, connected]);
}
