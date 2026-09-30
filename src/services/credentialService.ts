import * as SecureStore from 'expo-secure-store';

/**
 * Storage keys used for portal authentication tokens in Android Keystore.
 */
const KEY_PORTAL_USER_ID = 'form_c_portal_user_id';
const KEY_PORTAL_PASSWORD = 'form_c_portal_password';

export interface PortalCredentials {
  userId: string | null;
  password: string | null;
}

/**
 * Persists Form-C portal username and password encrypted at rest
 * inside hardware-backed Android Keystore / EncryptedSharedPreferences.
 *
 * @param userId - The portal username / User ID string
 * @param password - The portal password string
 */
export const savePortalCredentials = async (
  userId: string,
  password: string
): Promise<void> => {
  try {
    // 1. Save user ID securely
    await SecureStore.setItemAsync(KEY_PORTAL_USER_ID, userId.trim());

    // 2. Save password securely
    await SecureStore.setItemAsync(KEY_PORTAL_PASSWORD, password);

    console.log('[CredentialService] Portal credentials securely stored.');
  } catch (error) {
    console.error('[CredentialService] Failed to persist credentials to SecureStore:', error);
    throw new Error('Could not securely store credentials on device.');
  }
};

/**
 * Retrieves the stored portal credentials from encrypted storage.
 *
 * @returns Object containing userId and password (or null if not configured)
 */
export const getPortalCredentials = async (): Promise<PortalCredentials> => {
  try {
    // 1. Retrieve user ID
    const userId = await SecureStore.getItemAsync(KEY_PORTAL_USER_ID);

    // 2. Retrieve password
    const password = await SecureStore.getItemAsync(KEY_PORTAL_PASSWORD);

    return {
      userId: userId || null,
      password: password || null,
    };
  } catch (error) {
    console.error('[CredentialService] Failed to retrieve credentials from SecureStore:', error);
    return { userId: null, password: null };
  }
};

/**
 * Removes both the stored User ID and Password from encrypted storage.
 */
export const clearPortalCredentials = async (): Promise<void> => {
  try {
    await SecureStore.deleteItemAsync(KEY_PORTAL_USER_ID);
    await SecureStore.deleteItemAsync(KEY_PORTAL_PASSWORD);
    console.log('[CredentialService] Portal credentials successfully cleared.');
  } catch (error) {
    console.error('[CredentialService] Failed to clear credentials from SecureStore:', error);
    throw new Error('Could not delete credentials from secure storage.');
  }
};