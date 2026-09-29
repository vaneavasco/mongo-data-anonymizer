# Audit: probleme, sugestii și plan de lucru

Branch: `audit-fixes-modernization` · Data auditului: 2026-09-29

Fiecare bug se repară împreună cu un test care îl reproduce.

## 🔴 Critice

- [x] **1. Pachetul publicat (0.2.1) nu pornește** — `@faker-js/faker` e în `devDependencies`, dar e folosit la runtime (`Cannot find module '@faker-js/faker'`). `faker` v5 și `@types/faker` sunt nefolosite.
- [x] **2. `--copyNonAnonymized` fără `--collectionList` copiază TOT neanonimizat** (`src/main.ts:33`) — `!collectionList.includes(name)` e mereu `true` când lista e goală.
- [x] **3. Tipurile non-string sunt stricate sau scapă neanonimizate** (`anonymize.ts:28-35`):
  - `Date` → `{}`, `null` → `{}`, `[]` → `{}`
  - `['john@x.com']` → `[{0:'j',1:'o',...}]` (emailul rămâne în clar)
  - `address: {street, city}` → `street` rămâne original
- [x] **4. Câmpuri imbricate sub chei nelistate nu sunt anonimizate** — `profile: {email, name}` trece neatins.

## 🟠 Importante

- [x] **5. Erorile sunt înghițite, exit code 0** (`main.ts:60`, `cli.ts:4`).
- [x] **6. Rerularea pe același target crapă la jumătate** (E11000 pe `_id`); `dropCollectionIfExists` nu e folosit și nu șterge colecțiile goale.
- [x] **7. README trimite la alt pachet** (`mongodb-anonymizer` în loc de `mongo-data-anonymizer`).
- [x] **8. Prefixele `+`/`-` din `--fieldList` se aplică întregii liste** — `+age,-email` adaugă un câmp numit `-email`.
- [x] **9. Înlocuirile care conțin `:` sunt trunchiate** — `users.name:http://example.com` → `//example.com`.
- [x] **10. Un test pică pe Node nou** — aserțiune pe textul exact al erorii din `JSON.parse`.

## 🟡 Funcționalități noi

- [x] **11. Anonimizare deterministă** (prioritate mare) — aceeași valoare originală → aceeași valoare falsă, în toate colecțiile și între rulări; derivată cu HMAC dintr-un secret (`--secret` / `ANONYMIZER_SECRET`), ca să nu se poată inversa prin dicționar. Emailurile primesc un sufix din hash pentru a evita coliziuni pe indexuri unique.
- [x] **12. Copierea indexurilor** (inclusiv unique) în target.
- [x] **13. Copierea view-urilor**; colecțiile `system.*` sunt ignorate.
- [x] **14. Protecție când sursa și ținta sunt aceeași bază de date.**
- [x] **15. `--dryRun`** — arată ce se întâmplă cu fiecare colecție, fără să scrie nimic.
- [x] **16. `--dropTarget`** — golește explicit colecțiile din target; fără el, rularea se oprește dacă target-ul are deja date.
- [x] **17. Pipelining** — batch-ul următor se citește în timp ce se inserează cel curent.

## 🔧 Modernizare / tooling

- [x] **18. Node 24** pentru dezvoltare (`.nvmrc`); `engines: ">=22.13"` (minimul cerut de faker 10); CI testează pe 22 și 24.
- [x] **19. ESM** (`"type": "module"`), TypeScript 6, `module: nodenext` — necesar pentru faker 10 și yargs 18 (doar ESM).
- [x] **20. Actualizarea dependențelor** — mongodb 7, @faker-js/faker 10, yargs 18.
- [x] **21. Jest → Vitest.**
- [x] **22. ESLint 10 flat config + typescript-eslint + Prettier 3**; lint rulat în CI.
- [x] **23. Bunyan → logger simplu, lizibil, pe stderr.**
- [x] **24. GitHub Actions** — `checkout@v4`/`setup-node@v4`, `npm ci`, lint + build + test, publicare cu provenance.
- [x] **25. `"files": ["dist"]`** în `package.json`; `.npmrc` scos (`always-auth` depreciat; token-ul îl pune `setup-node` în CI); reparat scriptul `start`; curățat `tsconfig` (decoratori).
- [x] **26. Teste de integrare cu `mongodb-memory-server`** pentru fluxul complet (`main`), plus teste pentru logica de colecții și tipuri.
- [x] **27. README rescris** pentru toate opțiunile noi.
- [x] **28. Versiune nouă: 0.3.0** (breaking: Node ≥22.13, ESM, `--dropTarget`).

## Găsite în timpul implementării

- [x] **29. Promise respins fără handler în copierea cu pipelining.** Dacă o inserare eșua în timp ce se citea batch-ul următor, procesul murea fără să închidă conexiunile. Reparat și acoperit de test (validator copiat care respinge valorile false).
- [x] **30. `--version` afișa versiunea din `package.json`-ul directorului curent**, nu a pachetului. Reparat.
- [x] **31. README:** notă despre validatorii care pot respinge valorile false și secțiunea „Upgrading from 0.2”.

- [x] **32. Cazuri numerice limită:** fracțiile sub 1 rămân sub 1, `NaN`/`Infinity` rămân neschimbate.
- [x] **33. Teste pentru colecții capped/time series și index unique care nu mai ține** (warning, nu eșec).
- [x] **34. `engines` relaxat la `>=22.13`**, verificat local pe Node 22.15 (build + toate testele).

## Review Fable (2026-09-29)

### Critic
- [x] **35. Protecția sursă = țintă poate fi păcălită** (standalone/mongos, tunel SSH, alt port) — cu `--dropTarget` șterge sursa. Soluție: comparare după UUID-urile colecțiilor + o colecție-sondă creată în țintă și căutată în sursă (sigur pe orice topologie).

### Importante
- [x] **36. Colecții inexistente în `--collectionList` / `--ignoreCollections` / reguli `colectie.camp`** → eroare (un typo + `--copyNonAnonymized` copia tot neanonimizat).
- [x] **37. `faker.date.*` depindea de data curentă** → dată de referință fixă pe instanța faker.
- [x] **38. Validarea regulilor apelează efectiv fiecare metodă faker** (metodele care cer argumente crăpau după `--dropTarget`).

### Minore
- [x] **39. Regulile pentru câmpuri din subdocumente deja potrivite** se aplică (ex. `address` + `city:REDACTED`).
- [x] **40. `faker.*` explicit pe numere/date** e respectat, nu ignorat.
- [x] **41. `_id` compus:** comportament clar și documentat.
- [x] **42. Date BSON invalide** → lăsate neschimbate cu warning, nu opresc rularea.
- [x] **43. String-urile goale rămân goale.**
- [x] **44. Index clustered cu nume custom** → fără warning fals.
- [x] **45. Variabile `ANONYMIZER_*` necunoscute** nu mai opresc CLI-ul.
- [x] **46. URI fără nume de bază de date** → eroare.
- [x] **47. README:** afirmațiile absolute corectate.

### Lipsuri
- [x] **48. `--strict`:** eșuează dacă rămân valori neanonimizabile (Decimal128, Binary, Long...).
- [x] **49. Teste:** ghidaj sursă = țintă pe alt port, numărul de documente într-o rulare reală, `--dropTarget` nu atinge alte colecții, CLI (exit code, `--version`), smoke test al pachetului în CI.
- [x] **50. `--dryRun` arată câmpuri care par date personale** dar nu se potrivesc cu nicio regulă.

### Găsite la re-verificare (după review)
- [x] **51. `_id` din subdocumente potrivite** (ex. Mongoose: `address: { _id, street }`) dădea warning la fiecare rulare și oprea rularea cu `--strict`. Acum e păstrat, ca `_id`-ul documentului.
- [x] **52. Testul de scriere pentru sursă = țintă** citește din primar (merge și cu `readPreference=secondary` în URI) și dă un mesaj clar dacă lipsește permisiunea de a crea colecții.

## Al doilea review Fable + dry-run pe baza locală UpTrek

- [x] **53. Variabile de mediu booleene:** `1/true/yes/on` și `0/false/no/off` acceptate, orice altceva e eroare.
- [x] **54. `--assumeDifferentTarget`:** ocolește explicit potrivirea după UUID/host (backup restaurat cu `--preserveUUID`, stack-uri docker identice); testul de scriere rulează oricum. Mesajul numește ambele baze.
- [x] **55. Secret gol** = fără secret (aleator), nu cheie goală.
- [x] **56. `faker.*` explicit pe o dată invalidă** e aplicat.
- [x] **57. README:** contradicțiile corectate (dry-run fără testul de scriere, `faker.*` vs null/goale, opțiuni repetate).
- [x] **58. Detecția câmpurilor personale:** acronime (`IPAddress`, `SSNNumber`) și fără alarme false (`emailTemplate`, `emailVerified`, `sendGuaranteedEmail`).
- [x] **59. „Nicio colecție anonimizată”:** view-urile nu contează; o rulare care nu scrie nimic dă warning.
- [x] **60. Colecția-sondă:** erorile au context, o ștergere eșuată nu ascunde rezultatul, sonde rămase din rulări vechi sunt semnalate, citire repetată scurt dacă sursa e un secundar.
- [x] **61. URI cu nume de bază invalid** → eroare clară.
- [x] **62. Log:** lista de câmpuri afișată o singură dată.
- [x] **63. Rulare reală pe baza locală UpTrek** (`heroku_bq8z44jn` → `anonymizer_test`) și verificarea rezultatului.
- [x] **64. Găsit la rularea reală:** `email.events.recipient` (883 emailuri personale) nu era semnalat de dry-run și primea un cuvânt aleator în loc de email, deci același email devenea altceva în colecții diferite. Acum: dry-run semnalează și valorile care conțin emailuri, iar orice valoare care e un email primește un email fals, indiferent de numele câmpului.
- [x] **65. Câmpurile de text liber** (`note`, `message`, `body`) primesc propoziții, nu un singur cuvânt.

### Rezultatul rulării reale (heroku_bq8z44jn → anonymizer_test)
- 60 de colecții, ~55.000 de documente, 17 secunde, exit 0, fără warning-uri.
- Structură identică: număr de documente, `_id`, indexuri, tipuri de colecții.
- 158.675 de valori înlocuite; 4.589 de emailuri reale → 4.589 emailuri false distincte, toate pe `example.com`, fiecare consistentă între colecții (497 apar în mai multe colecții).
- Emailuri reale rămase doar în câmpuri care nu sunt personale: id-uri de mesaj `mg.uptrek.com` și un email de business Allianz în FAQ.
- A doua rulare cu același secret: date identice (același hash); alt secret: date diferite.
- MongoDB-ul local a căzut după ~6 rulări complete cu `--dropTarget`: `Too many open files` în container (limita implicită de file descriptors; MongoDB recomandă ≥ 64000). Nu e un bug al tool-ului.


## 0.3.0 utilizabil din prima (cerut după rularea reală)

- [x] **66. Tipare în reguli:** `*` în numele câmpului (`*email`, `users.*phone`), fără diferență între majuscule și minuscule.
- [x] **67. Regulile implicite folosesc tipare**, ca să prindă variante reale (`orderEmail`, `guestEmail`, `phoneNo`, `recipient`, `displayName`, `*address`, `*token`, `password`...), fără alarme false (`emailTemplate`, `emailVerified`).
- [x] **68. Generatoarele după numele câmpului** acoperă variantele (`phoneNo`, `ipAddress` înaintea `*address`, `password`/`token` → șir aleator).
- [x] **69. `--scrubEmails` (implicit activ):** orice email din orice valoare, inclusiv din text liber, e înlocuit cu același email fals determinist.
- [x] **70. `--sampleSize` pentru dry-run** (implicit 1000, 0 = toată colecția).
- [x] **71. README: „Before using on production data”.**
- [x] **72. Rulare reală pe baza locală doar cu regulile implicite** + verificare (scurgeri, consistență, structură, determinism).

## Optimizări (recomandate de Fable, măsurate)

- [x] **73. Generator aleator rapid (sfc32) pentru faker**, seed-uit direct din HMAC; + test care fixează valorile false (garda de reproductibilitate).
- [x] **74. Indexuri pe replica set:** un singur `createIndexes` per colecție (fallback per index la eroare), `commitQuorum: 1` implicit pe replica set (`--indexCommitQuorum`), timeout (`--indexTimeout`, implicit 15 min; `timeoutMS`, pentru că driver-ul 7 nu mai trimite `maxTimeMS` la `createIndexes`).
- [x] **75. Progres și avertisment de blocaj:** documente/s și ETA per colecție; warning dacă nimic nu avansează 30 s, cu operația în așteptare.
- [x] **76. Limită de ~16 MB pe batch** (pe lângă `--batchSize`).
- [x] **77. README:** `ulimit nofile`, commit quorum, write concern din URI, mesajele de progres.
- [x] **78. Rulare reală pe baza locală** (după repornirea secundarului) cu regulile implicite + verificări.
- [x] **78. Rulare reală cu regulile implicite:** 60 de colecții, 55.257 de documente în 7 s (înainte 17 s), fără warning-uri; 0 emailuri reale rămase, 0 valori acoperite de reguli nemodificate, 4.589 emailuri → 4.589 false consistente; toate documentele identice cu o anonimizare nouă (determinism).
- [x] **79. Înlocuirea `:keep`** (găsit la rularea reală: regulile implicite înlocuiau și conținut de business, ex. `images.name`, descrierile și adresele experiențelor): păstrează câmpul întreg (cu subdocumente) pentru o colecție; doar emailurile din el sunt tot înlocuite.

## Al treilea review Fable (înainte de publicare)

- [x] **80. (Blocker) Parole criptate și chei API:** `passwordHash`, `passwordSalt`, `tokenHash`, `apiKey`, `secretKey` acoperite de regulile implicite și semnalate de dry-run.
- [x] **81. `username` unic:** sufix din hash (ca la emailuri), fără duplicate pe indexuri unique.
- [x] **82. Mesajul din `--strict`** recomandă scoaterea regulii pentru câmpurile cu referințe, nu `:null`; frază în README.
- [x] **83. `--indexCommitQuorum` validat** la pornire (`majority`, `votingMembers` sau număr).
- [x] **84. Avertismentul de blocaj în dry-run și la view-uri** numește operația corectă.
- [x] **85. Structura din subdocumente potrivite:** GeoJSON (`type` păstrat, coordonate `Point` valide), `type`/`kind` păstrate, `lat`/`lng` în intervale valide.
- [x] **86. `Nume <email>`:** emailul primește același fals ca peste tot, numele un nume fals; `<email>` și `email.` normalizate.
- [x] **87. Înlocuirea emailurilor nu strică URL-uri:** `git@host:repo`, `https://user@host/`, `mongodb://u:p@host`.
- [x] **88. Timeout-ul la indexuri** se aplică o singură dată per colecție și în reîncercarea per index.
- [x] **89. mongos (cluster sharded)** detectat pentru `commitQuorum`.
- [x] **90. Versiunea faker fixată exact** (reproductibilitate între instalări) + notă în README.
- [x] **91. Emailuri cu caractere non-ASCII** în partea locală sunt înlocuite.
- [x] **92. Precedența:** regulile unei colecții (exacte sau tipare) înaintea celor globale.
- [x] **93. README:** „în orice valoare string” (nu și chei), potriviri în plus cunoscute (`-*token`, `-*address`), rolurile/categoriile cu `name`.
- [x] **94. Rulare reală finală** (reguli implicite + `:keep` pentru conținutul de business): 60 de colecții în 7 s, fără warning-uri; 0 emailuri reale rămase, structură identică, 4.589 emailuri consistente fără coliziuni, toate cele 55.257 de documente deterministe.


## Al patrulea review Fable

- [x] **95. (Blocker, regresie) Emailuri urmate de `:` sau `/` în text** sunt din nou înlocuite; se exclud doar `user@host:ceva-lipit` și URL-urile (`//`).
- [x] **96. GeoJSON:** doar coordonatele au tratament special; restul cheilor trec prin reguli; doar tipurile GeoJSON reale.
- [x] **97. Coordonate în format vechi `[lng, lat]`** primesc valori valide.
- [x] **98. snake_case / kebab-case:** regulile ignoră `_` și `-` din numele cheilor (`api_key`, `first_name`, `phone_number`...).
- [x] **99. Dry-run vede în interiorul câmpurilor `:keep`.**
- [x] **100. Câmpurile `type`/`kind` păstrate** trec prin înlocuirea emailurilor.
- [x] **101. Liste de adrese pe chei de email** (`a@x.com, Jane <b@y.com>`) consistente; `mailto:` pe chei de email.
- [x] **102. `KEEP`/`Null` cu majuscule** respinse ca greșeli de tipar.
- [x] **103. Raportul nu listează câmpurile `:keep` ca anonimizate.**
- [x] **104. Reîncercarea per index** folosește timpul rămas din `--indexTimeout` al colecției.
- [x] **105. README:** potriviri în plus (`passwordPolicy`, `passwordUpdatedAt`, `salt`), `{lat, lng}`, domenii internaționalizate, precedența tiparelor, excluderile de URL.
- [x] **106. Rulare reală după runda 4:** 60 de colecții în 7 s, fără warning-uri; 0 emailuri reale rămase, structură identică, 4.589 emailuri consistente, toate cele 55.257 de documente deterministe; dry-run-ul semnalează acum și cheile din câmpurile `:keep`.


## Review final Fable (verdict: go) — ultimele reparații

- [x] **107. `Nume <email>` în câmpuri fără regulă** (`to`, `cc`, `from`, `headers.From`): numele devine fals, emailul același fals ca peste tot.
- [x] **108. Email urmat de `:` și HTML/punctuație** (`jane@x.com:<br>`, `jane@x.com:)`) e înlocuit.
- [x] **109. GeoJSON care nu e `Point`** (trasee, zone) devine o formă mică, validă, în jurul unei poziții false.
- [x] **110. Raportul** nu mai listează ca anonimizat un câmp umbrit de un `:keep` al colecției.
- [x] **111. Perechile de coordonate** doar pe chei geo (`coordinates`, `loc`, `location`, `geo`, `position`...) și nu când regula are o metodă faker explicită.
- [x] **112. Regula adăugată de utilizator câștigă** în fața celei implicite pentru același câmp (`+first_name:REDACTED`).
- [x] **113. `name: keep` (cu spațiu)** respins ca probabilă greșeală.
- [x] **114. Rulare reală finală:** 60 de colecții în 7 s, fără warning-uri; 0 emailuri reale rămase, structură identică, 4.589 emailuri consistente fără coliziuni, toate cele 55.257 de documente deterministe; 216 teste pe Node 22 și 24.

