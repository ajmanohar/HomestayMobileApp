// ==============================================================================
// App.tsx - HomestayMobileApp (React Native / Expo SDK 57)
// ==============================================================================
// Root application component managing state-based navigation across:
// 1. DASHBOARD: Queue of guest submissions with per-document stage badges.
// 2. CAPTURE: 5-step guided document ingestion (Passport, Dual Visa, Stamp, Form-C, Photo).
// 3. REVIEW: Pinch-to-zoom image inspection and editable Form-C fields.
//
// Lifecycle & Hardware Navigation Features:
// - Task 43: Mobile lifecycle terminates strictly at Review & Re-submit.
// - Task 46: Intercepts Android hardware back button & swipe gestures via BackHandler
//   to return to DASHBOARD rather than unexpectedly closing the application.
// ==============================================================================

import React, { useState, useEffect } from 'react';
import {
  View,
  ActivityIndicator,
  StyleSheet,
  StatusBar,
  BackHandler,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useAppTheme } from './src/theme/ThemeContext';
import { initDatabase } from './src/db/database';

// Screen Components
import DashboardScreen from './src/screens/DashboardScreen';
import { CaptureScreen } from './src/screens/CaptureScreen';
import ReviewScreen from './src/screens/ReviewScreen';

/**
 * Valid screen routes for top-level navigation.
 */
type AppScreen = 'DASHBOARD' | 'CAPTURE' | 'REVIEW';

/**
 * Inner application component with theme tokens and navigation handling.
 */
const MainApp: React.FC = () => {
  // Theme context providing active light/dark palette and toggle handler
  const { colors, isDark } = useAppTheme();

  // Active top-level screen identifier
  const [currentScreen, setCurrentScreen] = useState<AppScreen>('DASHBOARD');

  // Currently selected submission UUID being inspected in ReviewScreen
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(null);

  // Database initialization readiness flag
  const [isDbReady, setIsDbReady] = useState<boolean>(false);

  // ----------------------------------------------------------------------------
  // 1. Initialize SQLite Database Schema on Cold Boot
  // ----------------------------------------------------------------------------
  useEffect(() => {
    const bootstrap = async () => {
      try {
        console.log('[App] Initializing SQLite database schema...');
        await initDatabase();
        console.log('[App] SQLite database successfully initialized and ready.');
        setIsDbReady(true);
      } catch (err) {
        console.error('[App] Failed to initialize SQLite database:', err);
        // Set ready to true so user interface does not hang indefinitely
        setIsDbReady(true);
      }
    };
    bootstrap();
  }, []);

  // ----------------------------------------------------------------------------
  // 2. Task 46: Android Hardware Back Button & Gesture Interception
  // ----------------------------------------------------------------------------
  useEffect(() => {
    /**
     * Handles Android physical back button presses and navigation swipe gestures.
     * If currently viewing CAPTURE or REVIEW, navigates back to DASHBOARD.
     * If already on DASHBOARD, returns false to let the OS minimize or exit the app.
     */
    const handleHardwareBackPress = (): boolean => {
      if (currentScreen !== 'DASHBOARD') {
        console.log(`[App] Hardware back pressed while on ${currentScreen}. Returning to DASHBOARD.`);
        setCurrentScreen('DASHBOARD');
        return true; // Consumes event and prevents Android OS from exiting the app
      }
      return false; // Allows default Android exit behavior on root DASHBOARD screen
    };

    // Register event listener with React Native BackHandler
    const backSubscription = BackHandler.addEventListener(
      'hardwareBackPress',
      handleHardwareBackPress
    );

    // Clean up subscription on unmount or when currentScreen changes
    return () => {
      backSubscription.remove();
    };
  }, [currentScreen]);

  // Render loading indicator until local database bootstrap finishes
  if (!isDbReady) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primaryBrand} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* 1. Dashboard Screen (Submissions Queue & Service Status Pills) */}
      {currentScreen === 'DASHBOARD' && (
        <DashboardScreen
          onStartNewCapture={() => {
            console.log('[App] Navigating to CAPTURE screen.');
            setCurrentScreen('CAPTURE');
          }}
          onOpenReview={(id: string) => {
            console.log(`[App] Navigating to REVIEW screen for submission: ${id}`);
            setActiveSubmissionId(id);
            setCurrentScreen('REVIEW');
          }}
        />
      )}

      {/* 2. Capture Screen (5-Step Camera Ingestion) */}
      {currentScreen === 'CAPTURE' && (
        <CaptureScreen
          onCaptureComplete={() => {
            console.log('[App] Capture completed. Returning to DASHBOARD.');
            setCurrentScreen('DASHBOARD');
          }}
          onCancel={() => {
            console.log('[App] Capture cancelled by operator. Returning to DASHBOARD.');
            setCurrentScreen('DASHBOARD');
          }}
        />
      )}

      {/* 3. Review & Verify Screen (Task 43: Review, Re-submit, and Cascade Delete) */}
      {currentScreen === 'REVIEW' && activeSubmissionId && (
        <ReviewScreen
          submissionId={activeSubmissionId}
          onBack={() => {
            console.log('[App] Back pressed on ReviewScreen. Returning to DASHBOARD.');
            setCurrentScreen('DASHBOARD');
          }}
          onComplete={() => {
            console.log('[App] Review concluded on ReviewScreen. Returning to DASHBOARD.');
            setCurrentScreen('DASHBOARD');
          }}
        />
      )}
    </View>
  );
};

/**
 * Root Application Container wrapped with SafeAreaProvider and ThemeProvider.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <MainApp />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});