import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.stonepropertysolutions.app',
  appName: 'Stone Property Solutions',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    SplashScreen: {
      // Crimson matches the WEB splash exactly (T.primary #B81D24). launchAutoHide:false
      // keeps the native launch screen up until the web is painted, then main.jsx calls
      // SplashScreen.hide() — so there's no white flash and only the crimson splash shows.
      launchAutoHide: false,
      backgroundColor: "#B81D24",
      showSpinner: false,
      androidSpinnerStyle: "small",
      iosSpinnerStyle: "small",
      spinnerColor: "#ffffff",
    },
    StatusBar: {
      style: "LIGHT",
      backgroundColor: "#B81D24",
    },
  }
};

export default config;
