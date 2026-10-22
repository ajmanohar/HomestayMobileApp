// ==============================================================================
// App.tsx - HomestayMobileApp (React Native / Expo SDK 57)
// ==============================================================================
// Root application component managing state-based navigation across:
// 1. DASHBOARD: Queue of guest submissions with per-document stage badges.
// 2. CAPTURE: 5-step guided document ingestion (Passport, Dual Visa, Stamp, Form-C, Photo).
// 3. REVIEW: Pinch-to-zoom image inspection and editable Form-C fields (Task 43).
//
// Lifecycle Constraint (Task 43):
// - Mobile lifecycle terminates strictly at Review & Re-submit.
// - Portal auto-submission is removed from mobile.
// ==============================================================================

import React, { useState, useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet, StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useAppTheme } from './src/theme/ThemeContext';
import { initDatabase } from './src/db/database';

// Screen Components
import DashboardScreen from './src/screens/DashboardScreen';
import { CaptureScreen } from './src/screens/CaptureScreen';
import ReviewScreen from './src/screens/ReviewScreen';

type AppScreen = 'DASHBOARD' | 'CAPTURE' | 'REVIEW';

const MainApp: React.FC = () => {
  const { colors, isDark } = useAppTheme();
  const [currentScreen, setCurrentScreen] = useState<AppScreen>('DASHBOARD');
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(null);
  const [isDbReady, setIsDbReady] = useState<boolean>(false);

  // Initialize SQLite database on cold start
  useEffect(() => {
    const bootstrap = async () => {
      try {
        console.log('[App] Initializing SQLite database...');
        await initDatabase();
        console.log('[App] Database ready.');
        setIsDbReady(true);
      } catch (err) {
        console.error('[App] Failed to initialize SQLite database:', err);
        setIsDbReady(true);
      }
    };
    bootstrap();
  }, []);

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

      {/* 1. Dashboard Screen */}
      {currentScreen === 'DASHBOARD' && (
        <DashboardScreen
          onStartNewCapture={() => setCurrentScreen('CAPTURE')}
          onOpenReview={(id: string) => {
            setActiveSubmissionId(id);
            setCurrentScreen('REVIEW');
          }}
        />
      )}

      {/* 2. Capture Screen */}
      {currentScreen === 'CAPTURE' && (
        <CaptureScreen
          onCaptureComplete={() => setCurrentScreen('DASHBOARD')}
          onCancel={() => setCurrentScreen('DASHBOARD')}
        />
      )}

      {/* 3. Review & Verify Screen (Task 43: Final mobile stage) */}
      {currentScreen === 'REVIEW' && activeSubmissionId && (
        <ReviewScreen
          submissionId={activeSubmissionId}
          onBack={() => setCurrentScreen('DASHBOARD')}
          onComplete={() => setCurrentScreen('DASHBOARD')}
        />
      )}
    </View>
  );
};

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