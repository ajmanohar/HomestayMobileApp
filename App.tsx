import React, { useState, useEffect } from 'react';
import { StyleSheet, ActivityIndicator, View, StatusBar } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ThemeProvider, useAppTheme } from './src/theme/ThemeContext';
import { initDatabase } from './src/db/database';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { ReviewScreen } from './src/screens/ReviewScreen';

/**
 * Screen identifier enum for local client state navigation.
 */
type ActiveScreen = 'DASHBOARD' | 'CAPTURE' | 'REVIEW';

/**
 * Main application container that accesses the active ThemeContext.
 */
const AppContent: React.FC = () => {
  const { colors, isDark } = useAppTheme();

  // Navigation state
  const [currentScreen, setCurrentScreen] = useState<ActiveScreen>('DASHBOARD');
  const [reviewSubmissionId, setReviewSubmissionId] = useState<string | null>(null);
  const [isDbReady, setIsDbReady] = useState<boolean>(false);

  // Initialize SQLite database on boot
  useEffect(() => {
    const setupStorage = async () => {
      try {
        await initDatabase();
        setIsDbReady(true);
      } catch (error) {
        console.error('[App] Failed to initialize SQLite database:', error);
      }
    };

    setupStorage();
  }, []);

  // Display loader while SQLite tables are configured
  if (!isDbReady) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primaryBrand} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.rootSafeArea, { backgroundColor: colors.surface }]} edges={['top', 'bottom']}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={colors.surface}
      />

      {/* Screen Router */}
      {currentScreen === 'DASHBOARD' && (
        <DashboardScreen
          onStartNewCapture={() => setCurrentScreen('CAPTURE')}
          onOpenReview={(id: string) => {
            setReviewSubmissionId(id);
            setCurrentScreen('REVIEW');
          }}
        />
      )}

      {currentScreen === 'CAPTURE' && (
        <CaptureScreen
          onCaptureComplete={() => setCurrentScreen('DASHBOARD')}
          onCancel={() => setCurrentScreen('DASHBOARD')}
        />
      )}

      {currentScreen === 'REVIEW' && reviewSubmissionId && (
        <ReviewScreen
          submissionId={reviewSubmissionId}
          onFinishReview={() => {
            setReviewSubmissionId(null);
            setCurrentScreen('DASHBOARD');
          }}
          onCancel={() => {
            setReviewSubmissionId(null);
            setCurrentScreen('DASHBOARD');
          }}
        />
      )}
    </SafeAreaView>
  );
};

/**
 * Root Application entry point wrapped in ThemeProvider and SafeAreaProvider.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  rootSafeArea: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});