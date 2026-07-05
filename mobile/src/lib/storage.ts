import * as SecureStore from 'expo-secure-store'

// Secure storage for API keys
export async function getSecure(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key)
  } catch {
    return null
  }
}

export async function setSecure(key: string, value: string): Promise<void> {
  return SecureStore.setItemAsync(key, value)
}

export async function deleteSecure(key: string): Promise<void> {
  return SecureStore.deleteItemAsync(key)
}

// Settings convenience
export async function getSettings(): Promise<Record<string, string>> {
  const raw = await SecureStore.getItemAsync('appSettings')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export async function saveSettings(settings: Record<string, string>): Promise<void> {
  await SecureStore.setItemAsync('appSettings', JSON.stringify(settings))
}
