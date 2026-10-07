import React, { forwardRef, useCallback } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, radius, themed } from '../theme/tokens';

/** Shared bottom-sheet chrome: dark surface, dynamic height, tap-out backdrop. */
export const Sheet = forwardRef<BottomSheetModal, { children: React.ReactNode; onDismiss?: () => void; scrollable?: boolean }>(
  ({ children, onDismiss, scrollable }, ref) => {
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    // Never taller than the screen (iPhone SE is 667 pt): leave the header peeking out above the sheet.
    const maxHeight = Math.min(640, height - insets.top - 72);
    const backdrop = useCallback((p: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.55} pressBehavior="close" />
    ), []);
    return (
      <BottomSheetModal
        ref={ref}
        enableDynamicSizing
        maxDynamicContentSize={maxHeight}
        onDismiss={onDismiss}
        backdropComponent={backdrop}
        backgroundStyle={styles.bg}
        handleIndicatorStyle={styles.handle}
        accessibilityLabel="Sheet"
      >
        {scrollable ? children : <BottomSheetView style={[styles.body, { paddingBottom: insets.bottom + 20 }]}>{children}</BottomSheetView>}
      </BottomSheetModal>
    );
  },
);

const styles = themed(() => ({
  bg: { backgroundColor: palette.surface, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, borderWidth: 1, borderColor: palette.hairline },
  handle: { backgroundColor: palette.textTertiary, width: 40 },
  body: { paddingHorizontal: 20, paddingTop: 4 },
}));
