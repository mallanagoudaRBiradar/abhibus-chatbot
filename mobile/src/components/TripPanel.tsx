import React, { useEffect, useState } from 'react';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Avatar } from './Avatar';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from './icons';
import * as Haptics from '../services/haptics';
import { Txt } from './Txt';
import { LiveDot } from './LiveDot';
import { useChat } from '../store/chatStore';
import { chatSocket } from '../services/socket';
import { useServerNow } from '../hooks/useNow';
import { ago, clock } from '../utils/format';
import { motion, palette, radius, themed } from '../theme/tokens';
import type { TripInfo } from '../shared/protocol';

/**
 * Top of the trip sheet (tap the route in the header). Two tabs side by side,
 * like Everyone | Women Zone:
 *   [ 🚌 Live tracking | 👥 Travellers ]
 *   Live tracking: where the bus is (GPS or timetable), a road with the bus riding
 *                  along it, then every stop with times, who boards/drops there,
 *                  your own stops marked and a "bus is here" marker.
 *   Travellers:    booked / in chat / online / women, a wall of everyone's trip
 *                  avatars (online first) and where people get on and off.
 * All from our DB; counts and trip names only, never real names or seats.
 * Refreshes every 30 s while open.
 */
export function TripPanel({ onOpenPassengers }: { onOpenPassengers: () => void }) {
  const [info, setInfo] = useState<TripInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'track' | 'people'>('track');
  const online = useChat((s) => s.rooms.MAIN_COMMON.presence.onlineSeats.length);
  const members = useChat((s) => s.rooms.MAIN_COMMON.presence.members);
  const mySeat = useChat((s) => s.session!.me.seat);
  const [w, setW] = useState(0);
  const x = useSharedValue(0);
  useEffect(() => { x.value = withSpring(tab === 'track' ? 0 : 1, motion.spring); }, [tab]);
  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * (w / 2) }] }));
  const now = useServerNow(15_000);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const ack = await chatSocket.tripInfo();
      if (!alive) return;
      if (ack.ok) { setInfo(ack.data); setFailed(false); } else setFailed(true);
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!info) {
    return (
      <View style={[styles.card, styles.center]}>
        {failed ? <Txt v="small" color={palette.textSecondary}>Couldn’t load trip details. Check your connection.</Txt> : <ActivityIndicator color={palette.red} />}
      </View>
    );
  }

  const t = info.travellers;
  const bus = info.bus;
  // Index where the bus marker sits: after the last passed stop.
  const busAt = info.stops.reduce((k, s, i) => (s.passed ? i + 1 : k), 0);
  const arrived = !!bus && bus.progress >= 0.995;
  const lateMin = bus?.eta ? Math.round((Date.parse(bus.eta) - Date.parse(info.schedule.arrives)) / 60_000) : 0;

  const inChat = Math.max(t.joined, online);
  const boardingSpots = info.stops.filter((x) => x.boarding > 0);
  const droppingSpots = info.stops.filter((x) => x.dropping > 0);

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.tabs} onLayout={(e) => setW(e.nativeEvent.layout.width - 8)} accessibilityRole="tablist">
        {w > 0 && <Animated.View style={[styles.tabPill, { width: w / 2 }, pill]} />}
        {([['track', 'Live tracking', 'bus'], ['people', 'Travellers', 'people']] as const).map(([k, label, icon]) => (
          <Pressable key={k} onPress={() => { if (tab !== k) { Haptics.selectionAsync(); setTab(k); } }} style={styles.tab}
            accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
            <Ionicons name={tab === k ? icon : (`${icon}-outline` as any)} size={15} color={tab === k ? palette.red : palette.textTertiary} />
            <Txt v="smallStrong" color={tab === k ? palette.red : palette.textSecondary}>{label}</Txt>
            {k === 'track' && bus?.source === 'GPS' && <LiveDot color={palette.green} size={6} />}
            {k === 'people' && <Txt v="micro" color={palette.textTertiary} style={{ fontVariant: ['tabular-nums'] }}>{inChat}</Txt>}
          </Pressable>
        ))}
      </View>

      {tab === 'track' ? (
      <Animated.View key="track" entering={FadeIn.duration(180)} style={styles.card}>
        <View style={styles.cardHead}>
          <Txt v="bodyStrong" style={{ flex: 1 }} numberOfLines={2}>
            {!bus ? 'Locating the bus…' : arrived ? `Bus reached ${bus.placeLabel}` : /^on the way/i.test(bus.placeLabel) ? `Bus is ${bus.placeLabel[0].toLowerCase()}${bus.placeLabel.slice(1)}` : `Bus near ${bus.placeLabel}`}
          </Txt>
          {bus && (
            <View style={[styles.source, bus.source === 'GPS' && { backgroundColor: palette.greenSoft }]}>
              {bus.source === 'GPS' ? <LiveDot color={palette.green} size={6} /> : <Ionicons name="time-outline" size={11} color={palette.textTertiary} />}
              <Txt v="micro" color={bus.source === 'GPS' ? palette.green : palette.textTertiary}>{bus.source === 'GPS' ? `GPS · ${ago(bus.fixAt!, now)}` : 'Estimated'}</Txt>
            </View>
          )}
        </View>

        {bus ? (
          <View style={{ marginBottom: 12 }}>
            <View style={styles.tiles}>
              <Tile label="Speed" value={bus.speedKmph != null && !arrived ? `${Math.round(bus.speedKmph)}` : '—'} unit={bus.speedKmph != null && !arrived ? 'km/h' : ''} />
              <Tile label={bus.nextStop ? `To ${bus.nextStop.name}` : 'Next stop'} value={bus.nextStop ? `${bus.nextStop.distanceKm}` : '—'} unit={bus.nextStop ? 'km' : ''} />
              <Tile label={lateMin >= 5 ? `${lateMin} min late` : 'Arrives'} value={bus.eta ? clock(bus.eta).replace(/ (AM|PM)$/, '') : '—'} unit={bus.eta ? clock(bus.eta).slice(-2) : ''} warn={lateMin >= 5} />
            </View>
            <Road progress={bus.progress} />
          </View>
        ) : (
          <Txt v="small" color={palette.textSecondary} style={{ marginBottom: 10 }}>No position yet. It shows once the bus sends GPS or the route is known.</Txt>
        )}

        {info.stops.length > 0 ? (
          <View>
            {info.stops.map((st, i) => (
              <React.Fragment key={`${st.name}-${i}`}>
                {bus && !arrived && i === busAt && <BusHere label={bus.placeLabel} />}
                <StopRow stop={st} first={i === 0} last={i === info.stops.length - 1} />
              </React.Fragment>
            ))}
            {bus && !arrived && busAt >= info.stops.length && <BusHere label={bus.placeLabel} />}
          </View>
        ) : (
          <Txt v="small" color={palette.textSecondary}>{`Departs ${clock(info.schedule.departs)} · Arrives ${clock(info.schedule.arrives)}`}</Txt>
        )}
      </Animated.View>
      ) : (
      <Animated.View key="people" entering={FadeIn.duration(180)} style={styles.card}>
        <View style={styles.stats}>
          <Stat n={t.booked} label="Booked" />
          <Stat n={inChat} label="In chat" />
          <Stat n={online} label="Online" dot />
          <Stat n={t.women} label="Women" />
          {t.guests > 0 && <Stat n={t.guests} label="QR guests" />}
        </View>

        {t.booked > 0 && (
          <View style={{ marginTop: 12, gap: 4 }}>
            <View style={styles.joinBar}><View style={[styles.joinFill, { width: `${Math.min(100, Math.round((inChat / Math.max(1, t.booked + t.guests)) * 100))}%` }]} /></View>
            <Txt v="micro" color={palette.textTertiary}>{inChat >= t.booked ? 'Everyone on this bus is in the chat 🎉' : `${t.booked + t.guests - inChat} more on this bus haven’t joined yet`}</Txt>
          </View>
        )}

        {members.length > 0 && (
          <>
            <Txt v="micro" color={palette.textTertiary} style={styles.section}>WHO’S HERE</Txt>
            <View style={styles.wall}>
              {members.slice(0, 15).map((m) => (
                <View key={m.seat} style={styles.wallItem}>
                  <Avatar name={m.name} avatar={m.avatar} size={42} online={m.online} />
                  <Txt v="micro" numberOfLines={1} color={m.seat === mySeat ? palette.red : palette.textSecondary} style={{ textAlign: 'center' }}>
                    {m.seat === mySeat ? 'You' : m.name.split(' ').slice(-1)[0]}
                  </Txt>
                </View>
              ))}
            </View>
          </>
        )}

        {(boardingSpots.length > 0 || droppingSpots.length > 0) && (
          <>
            <Txt v="micro" color={palette.textTertiary} style={styles.section}>GETTING ON AND OFF</Txt>
            {boardingSpots.map((st) => <Spot key={`b-${st.name}`} icon="arrow-up-circle" tone={palette.green} name={st.name} n={st.boarding} verb="boarding" />)}
            {droppingSpots.map((st) => <Spot key={`d-${st.name}`} icon="arrow-down-circle" tone={palette.red} name={st.name} n={st.dropping} verb="dropping" />)}
          </>
        )}

        <Pressable onPress={() => { Haptics.selectionAsync(); onOpenPassengers(); }} style={({ pressed }) => [styles.seeAll, pressed && { opacity: 0.7 }]} accessibilityRole="button">
          <Txt v="smallStrong" color={palette.red}>See everyone · report or block</Txt>
          <Ionicons name="chevron-forward" size={14} color={palette.red} />
        </Pressable>
      </Animated.View>
      )}
    </View>
  );
}

function Tile({ label, value, unit, warn }: { label: string; value: string; unit: string; warn?: boolean }) {
  return (
    <View style={styles.tile}>
      <Txt v="micro" color={warn ? palette.amber : palette.textTertiary} numberOfLines={1}>{label}</Txt>
      <Txt v="title" style={{ fontVariant: ['tabular-nums'] }} numberOfLines={1} adjustsFontSizeToFit>{value}<Txt v="micro" color={palette.textSecondary}>{unit ? ` ${unit}` : ''}</Txt></Txt>
    </View>
  );
}

/** A little highway: covered road in green, the bus riding on it, the flag at the end. */
function Road({ progress }: { progress: number }) {
  const pct = Math.max(0, Math.min(1, progress));
  return (
    <View style={styles.road}>
      <View style={styles.roadLine} />
      <View style={[styles.roadDone, { width: `${pct * 100}%` }]} />
      <View style={[styles.roadBus, { left: `${pct * 100}%` }]}><MaterialCommunityIcons name="bus" size={13} color="#FFFFFF" /></View>
      <Txt style={styles.roadFlag}>🏁</Txt>
    </View>
  );
}

function Spot({ icon, tone, name, n, verb }: { icon: any; tone: string; name: string; n: number; verb: string }) {
  return (
    <View style={styles.spot}>
      <Ionicons name={icon} size={16} color={tone} />
      <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>{name}</Txt>
      <Txt v="smallStrong" color={palette.textSecondary}>{`${n} ${verb}`}</Txt>
    </View>
  );
}

function Stat({ n, label, dot }: { n: number; label: string; dot?: boolean }) {
  return (
    <View style={styles.stat}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        {dot && <LiveDot color={palette.green} size={6} />}
        <Txt v="h3" style={{ fontVariant: ['tabular-nums'] }}>{n}</Txt>
      </View>
      <Txt v="micro" color={palette.textSecondary}>{label}</Txt>
    </View>
  );
}

function StopRow({ stop: s, first, last }: { stop: TripInfo['stops'][number]; first: boolean; last: boolean }) {
  const counts = [s.boarding ? `${s.boarding} boarding` : null, s.dropping ? `${s.dropping} dropping` : null].filter(Boolean).join(' · ');
  return (
    <View style={styles.stopRow}>
      <View style={styles.rail}>
        <View style={[styles.railLine, first && { top: '50%' }, last && { bottom: '50%' }, s.passed && { backgroundColor: palette.green }]} />
        <View style={[styles.node, s.passed ? { backgroundColor: palette.green, borderColor: palette.green } : null, s.mine && !s.passed && { borderColor: palette.red }]}>
          {s.passed && <Ionicons name="checkmark" size={9} color="#FFFFFF" />}
        </View>
      </View>
      <View style={{ flex: 1, paddingVertical: 8, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Txt v="smallStrong" numberOfLines={2} style={{ flex: 1 }} color={s.passed ? palette.textSecondary : palette.text}>{s.name}</Txt>
          {s.at && <Txt v="meta" color={palette.textSecondary} style={{ fontVariant: ['tabular-nums'] }}>{clock(s.at)}</Txt>}
        </View>
        {(counts || s.mine) && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {s.mine && <View style={styles.mine}><Txt v="micro" color={palette.red}>{s.mine === 'BOARD' ? 'Your boarding' : 'Your drop'}</Txt></View>}
            {!!counts && <Txt v="micro" color={palette.textTertiary}>{counts}</Txt>}
          </View>
        )}
      </View>
    </View>
  );
}

function BusHere({ label }: { label: string }) {
  return (
    <View style={styles.stopRow}>
      <View style={styles.rail}>
        <View style={[styles.railLine, { backgroundColor: palette.green, bottom: '50%' }]} />
        <View style={styles.busNode}><MaterialCommunityIcons name="bus" size={12} color="#FFFFFF" /></View>
      </View>
      <View style={{ flex: 1, paddingVertical: 6 }}>
        <Txt v="micro" color={palette.green}>{`BUS IS HERE · ${label.toUpperCase()}`}</Txt>
      </View>
    </View>
  );
}

const styles = themed(() => ({
  card: { padding: 14, borderRadius: radius.card - 4, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
  center: { alignItems: 'center', justifyContent: 'center', minHeight: 80 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  tabs: { flexDirection: 'row', height: 42, padding: 4, borderRadius: radius.chip + 2, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
  tabPill: { position: 'absolute', top: 3, left: 4, bottom: 3, borderRadius: radius.chip, backgroundColor: palette.surfaceRaised, borderWidth: 1, borderColor: palette.redBorder },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, minWidth: 0, paddingHorizontal: 8, paddingVertical: 10, borderRadius: radius.chip, backgroundColor: palette.surface, gap: 2 },
  road: { height: 26, marginTop: 14, marginRight: 22, justifyContent: 'center' },
  roadLine: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, backgroundColor: palette.track },
  roadDone: { position: 'absolute', left: 0, height: 4, borderRadius: 2, backgroundColor: palette.green },
  roadBus: { position: 'absolute', marginLeft: -11, width: 22, height: 22, borderRadius: 11, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: palette.surfaceSunk },
  roadFlag: { position: 'absolute', right: -22, fontSize: 15, lineHeight: 20 },
  joinBar: { height: 6, borderRadius: 3, backgroundColor: palette.track, overflow: 'hidden' },
  joinFill: { height: 6, borderRadius: 3, backgroundColor: palette.red },
  section: { letterSpacing: 0.8, marginTop: 16, marginBottom: 8 },
  wall: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  wallItem: { width: 54, alignItems: 'center', gap: 3 },
  spot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  seeAll: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 14, height: 40, borderRadius: radius.pill, borderWidth: 1, borderColor: palette.redBorder },
  stat: { minWidth: '25%', flexGrow: 1, gap: 1 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 22, borderRadius: radius.pill, backgroundColor: palette.surface },
  track: { height: 4, borderRadius: 2, backgroundColor: palette.track, marginTop: 8, overflow: 'hidden' },
  trackFill: { height: 4, borderRadius: 2, backgroundColor: palette.green },
  stopRow: { flexDirection: 'row', gap: 10, minHeight: 40 },
  rail: { width: 18, alignItems: 'center', justifyContent: 'center' },
  railLine: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: palette.hairlineStrong },
  node: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: palette.textTertiary, backgroundColor: palette.surfaceSunk, alignItems: 'center', justifyContent: 'center' },
  busNode: { width: 20, height: 20, borderRadius: 10, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  mine: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.pill, backgroundColor: palette.redSoft },
}));
