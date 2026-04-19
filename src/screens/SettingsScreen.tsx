import { View, Text } from 'react-native'
import React from 'react'
import { useHardwareButtons } from '../hooks/useHardwareButtons'

const SettingsScreen = () => {
  useHardwareButtons({
    onPowerDoublePress: () => {
      console.log('Power button double pressed!');
    },
  });

  return (
    <View>
      <Text>SettingsScreen</Text>
    </View>
  )
}

export default SettingsScreen