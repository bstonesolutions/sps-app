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
      launchShowDuration: 1500,
      backgroundColor: "#AF011A",
      showSpinner: false,
      androidSpinnerStyle: "small",
      iosSpinnerStyle: "small",
      spinnerColor: "#ffffff",
    },
    StatusBar: {
      style: "LIGHT",
      backgroundColor: "#AF011A",
    },
  }
};

export default config;
