// Firebase（Firestore）によるふたりの間の自動同期。
// firebase-config.js が設定されているときだけ読み込まれる。
const V = '10.12.2';
const BASE = `https://www.gstatic.com/firebasejs/${V}`;

export async function connect(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${BASE}/firebase-app.js`), import(`${BASE}/firebase-auth.js`), import(`${BASE}/firebase-firestore.js`),
  ]);
  const { emulator, ...options } = config;
  const app = initializeApp(options);
  const auth = A.getAuth(app);
  const db = emulator ? F.getFirestore(app) : F.initializeFirestore(app, {
    localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
  });
  if (emulator) {
    A.connectAuthEmulator(auth, `http://${emulator.auth}`, { disableWarnings: true });
    const [host, port] = emulator.firestore.split(':');
    F.connectFirestoreEmulator(db, host, Number(port));
  }
  const hhRef = (hid) => F.doc(db, 'households', hid);
  const expCol = (hid) => F.collection(db, 'households', hid, 'expenses');
  const clean = (o) => JSON.parse(JSON.stringify(o)); // undefined を取り除く

  async function writeExpenses(hid, list) {
    for (let i = 0; i < list.length; i += 400) {
      const b = F.writeBatch(db);
      for (const e of list.slice(i, i + 400)) b.set(F.doc(expCol(hid), e.id), clean(e));
      await b.commit();
    }
  }

  return {
    onAuth: (cb) => A.onAuthStateChanged(auth, cb),
    signIn: (email, pw) => A.signInWithEmailAndPassword(auth, email, pw),
    signUp: (email, pw) => A.createUserWithEmailAndPassword(auth, email, pw),
    signOut: () => A.signOut(auth),

    async myHousehold(uid) {
      const s = await F.getDoc(F.doc(db, 'users', uid));
      return s.exists() ? s.data().householdId : null;
    },
    async createHousehold(uid, meta, expenses) {
      const ref = F.doc(F.collection(db, 'households'));
      await F.setDoc(ref, clean({ ...meta, members: [uid], createdAt: Date.now() }));
      await F.setDoc(F.doc(db, 'users', uid), { householdId: ref.id });
      await writeExpenses(ref.id, expenses);
      return ref.id;
    },
    async joinHousehold(uid, hid) {
      await F.updateDoc(hhRef(hid), { members: F.arrayUnion(uid) });
      await F.setDoc(F.doc(db, 'users', uid), { householdId: hid });
    },
    // onMeta(data), onExpenses(list, fromServer)
    subscribe(hid, onMeta, onExpenses, onError) {
      const u1 = F.onSnapshot(hhRef(hid), (s) => s.exists() && onMeta(s.data()), onError);
      const u2 = F.onSnapshot(expCol(hid), { includeMetadataChanges: true },
        (s) => onExpenses(s.docs.map((d) => d.data()), !s.metadata.fromCache), onError);
      return () => { u1(); u2(); };
    },
    saveMeta: (hid, patch) => F.updateDoc(hhRef(hid), clean(patch)),
    saveExpense: (hid, e) => F.setDoc(F.doc(expCol(hid), e.id), clean(e)),
    saveExpenses: writeExpenses,
  };
}
