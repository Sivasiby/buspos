import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient } from '@supabase/supabase-js'
import 'react-native-url-polyfill/auto';

// export const supabaseUrl = 'https://gayoyiokhdixavjfuxvk.supabase.co'
// export const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdheW95aW9raGRpeGF2amZ1eHZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEzNjAyOTgsImV4cCI6MjA3NjkzNjI5OH0.W3NLBM-G6S4z-VEwJBLjZ91n28itZL_HhRnY71LKP94'



export const supabaseUrl = 'https://wwzvzglspewaomvbbdtx.supabase.co'
export const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3enZ6Z2xzcGV3YW9tdmJiZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4MzI5NTcsImV4cCI6MjA4NzQwODk1N30.axHCOh2XIEOMa4FaHLdhEDkcNNYfkMW3T_yKep_dwmY'






// Validate environment variables
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

// eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdheW95aW9raGRpeGF2amZ1eHZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEzNjAyOTgsImV4cCI6MjA3NjkzNjI5OH0.W3NLBM-G6S4z-VEwJBLjZ91n28itZL_HhRnY71LKP94
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})