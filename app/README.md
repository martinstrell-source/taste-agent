# Taste Agent app (Expo, iPhone first)

Sign in with an email code, then Nearby: your saves and new picks around you, on a map and a list.
It reads the same Supabase database as the pipeline scripts, through the `nearby()` function.
Row level security means each person only sees their own saves.

## Run it on your phone (Expo Go)

```bash
cd app
cp .env.example .env      # then fill in the two public values (Supabase URL and publishable key)
npm install
npx expo start            # scan the QR code with the iPhone camera; phone and Mac on the same Wi-Fi
npx expo start --tunnel   # if the phone can't reach the Mac
```

Sign-in needs the Supabase "Magic link or OTP" email template to include `{{ .Token }}`
(custom SMTP has to be on to edit templates). Only existing accounts can sign in for now;
add people with `users.py add` or `onboard.py`.

## Code

- `src/app/_layout.tsx`: sign-in gate
- `src/app/index.tsx`: Nearby screen (map, radius, saves/picks filter, search this area)
- `src/components/`: SignIn, PlaceCard
- `src/lib/`: Supabase client and `fetchNearby`, formatting, colors

Checks: `npm run typecheck`
