# Handover experiment: test script

The question: can two phones show they were together, in the browser, using only passkeys?

The seller's device opens the handover page. The page asks the browser to make a passkey on another device. The browser shows a QR code; the buyer scans it with their phone and confirms with Face ID or a fingerprint. For this phone-to-phone flow, the data travels over an encrypted internet link, but the two devices must also find each other over Bluetooth before it can finish. So if it finishes, the phones were probably near each other at that moment.

Everything happens in the page. Nothing is sent anywhere. You send the reports back by hand.

## Before you start

1. Open the handover page on the seller's device at the site's HTTPS address, ending in `/handover/`. Use the same address for every test: each address counts as a separate site, so a passkey made on one address doesn't work on another. That includes a Vercel preview address.
2. On both devices, turn on Bluetooth and internet (wifi or mobile data).
3. On the buyer's phone:
   - Face ID, Touch ID or a fingerprint must be set up.
   - On an iPhone, iCloud Keychain must be on (Settings, your name, iCloud, Passwords).
   - On Android, a Google account must be signed in.
4. Each successful run leaves a test passkey on the buyer's phone, named "Forest handover" plus six characters, under the site's address. Delete them when you are done:
   - iPhone: the Passwords app.
   - Android: Google Password Manager.
5. One report per case:
   1. Press **Clear report**.
   2. Run the case.
   3. Type what you did in the note box.
   4. Press **Download report**.

   If a case needs several tries, keep them all in one report: every try is recorded, failures too.

## What to read on the page

- **Attachment**: how this ceremony went.
  - `cross-platform`: the passkey is on another device (the phone-to-phone flow).
  - `platform`: the passkey is on this device.

  This is the field that tells a handover from a same-device control.
- **Transports**: the ways this passkey says it can be used *later*. It does not say how it travelled this time. A phone's passkey may say `["hybrid","internal"]` in every case. Write down what it shows.
- **User verified**: yes means the buyer's phone checked a face, a fingerprint or a PIN.
- **AAGUID**: names the passkey manager that made the passkey (iCloud Keychain, Google Password Manager and so on). All zeros means the phone didn't say.
- **Signature at creation**: always "none". Making a passkey this way returns no signature. The signature is checked at Confirm again.
- **Confirm again, signature**:
  - `valid`: the buyer's phone signed this deal with the passkey it just made, and the page checked the signature itself.
  - `NOT valid`: something is wrong; note it.

## Case 1: iPhone to iPhone

1. On the seller's iPhone, open the page in Safari.
2. Choose "another device: a QR code (the test)" and press **Clear report**.
3. Press **Start handover**. The page shows the deal id and the time.
4. On the seller's iPhone, a passkey sheet appears. If it asks where to save the passkey, choose the option for another device (a phone or tablet) until it shows a QR code. Write down the words it uses.
5. On the buyer's iPhone, open the Camera and point it at the QR code. Tap the passkey prompt that appears and confirm with Face ID.
6. Wait until the seller's page says "Handover recorded". Expected:
   - Attachment `cross-platform`
   - User verified `yes`
   - Checks at creation "all passed"
7. Press **Confirm again**. A new QR code appears. Scan it with the same buyer iPhone and confirm. Expected: Confirm again 1 signature `valid`.
8. In the note, write:
   - the buyer's phone model and iOS version
   - what each screen said
   - roughly how long it took
9. Press **Download report**.

## Case 2: other pairs, and a laptop as the seller

Repeat case 1, step for step, for each pair:

- **2a.** Seller iPhone, buyer Android.
- **2b.** Seller Android, buyer iPhone.
- **2c.** Seller Android, buyer Android.
- **2d.** Seller laptop (Chrome or Safari on a Mac, Chrome or Edge on Windows), buyer iPhone, then buyer Android.

Differences to expect:

- On Android, scan with the camera app or Google Lens. The prompt may say "Use a passkey from a nearby device" or similar. Write down the words.
- If a phone can't show a QR code for another device at all, that is a result. Write down what it offers instead and download the report.
- A laptop's browser may show the name of a phone it has used before instead of a QR code. If so, note that. Then choose the QR code option if there is one, so the case is the same as the others.

## Case 3: a buyer with no passkey at all

Use a buyer phone that has never saved a passkey, if you have one. Otherwise, a phone that has none for this site.

1. Run case 1's steps.
2. Every handover makes a new passkey, so being asked to create one is the normal case here. What to note:
   - Does the phone ask to save or create a passkey?
   - Does it first ask you to set something up (turn on iCloud Keychain, pick a password manager, set a screen lock)?
   - Does it finish?

## Case 4: the cheat, a screenshot sent to another building

1. On the seller's device, press **Start handover**.
2. Take a screenshot of the QR code and send it by message to someone in another building.
3. That person scans the screenshot with their phone and tries to confirm.
4. Expected: it never finishes.
   - Their phone probably stays on "connecting" or says it can't reach the other device.
   - The seller's page says "Failed after …" when the browser gives up, which should be about two minutes.
5. In the note, write what their phone said, word for word (or ask them for a screenshot) and how long it took.
6. Download the report.
7. If their phone did save a passkey, that would be surprising. Write it down, then have them delete it.

## Case 5: same device, the control

This is the check that the page can tell the two flows apart.

1. On the seller's phone, choose "this device (the control)" and press **Clear report**.
2. Press **Start handover**. Confirm on the same phone with your own Face ID or fingerprint. There is no QR code.
3. Expected: Attachment `platform`, not `cross-platform`.
4. Transports: the task expected `["internal"]` without `"hybrid"`. It may well say both, because the list describes later use, not this ceremony. Write down what it says either way.
5. Press **Confirm again**. It should sign in on the same phone. Expected: signature `valid`, and Confirm again 1 attachment `platform`.
6. Download the report. If you can, do the same on a laptop.

## Case 6: Bluetooth off

Do this twice. Each time, turn Bluetooth off in **Settings**. On an iPhone, the Control Centre switch only disconnects accessories and leaves Bluetooth on.

- **6a.** Bluetooth off on the seller's device, on for the buyer.
- **6b.** Bluetooth on for the seller, off on the buyer's phone.

For each:

1. Press **Start handover** and have the buyer scan the QR code.
2. Expected: it fails, or the browser won't show a QR code at all.
3. In the note, write the message on each device, word for word.
4. Download the report.

## What to send back

For each case:
- the downloaded report (the file name starts with `handover-`)
- one line on what happened

For example: "2b: seller Pixel 8, buyer iPhone 15, worked, 25 s, the Pixel called it 'Use a passkey from a nearby device'."

## What this is not

- **Not proof of what was handed over.** It shows that two devices completed a passkey ceremony. It says nothing about what changed hands.
- **Not proof of who the buyer is.** A new passkey belongs to nobody yet. Who the buyer is would come later, from the buyer's profile signing the same deal id.
- **It needs Bluetooth and internet on both devices.** The data goes over the internet. Bluetooth only checks that the devices are near.
- **Not proof to anyone else.**
  - The closeness check is done by the seller's browser. The page writes down what that browser reports.
  - Nothing the buyer's phone signs says how the ceremony travelled.
  - So the report is evidence to whoever trusts the seller's device. It is not evidence to a third party, such as a site weighing a review.
  - A buyer and seller who agree to cheat could produce the same report without meeting: run the control, then edit two words.
  - The one part anyone can check for themselves is the buyer's signature over the deal, from Confirm again.
- **Bluetooth range is not a fixed distance.** Someone with two radios and an internet link can relay the Bluetooth signal between places far apart. Case 4 does not test that.

## How the deal is built

So anyone can recompute the report:

- The deal id is 16 random bytes.
- The session key is a P-256 key made in the page. Its private half never leaves the page and isn't used.
- The challenge the buyer's phone confirms is SHA-256 of the deal id's bytes followed by the session public key's 65 raw bytes. Both passkey calls use it.
- The report keeps every byte the browser returned, in base64url, under `raw`.
- The public key is under `publicKey` (SPKI). `publicKeyAlgorithm` is `-7` for ES256 or `-257` for RS256.
