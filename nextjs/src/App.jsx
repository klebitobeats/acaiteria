import React, { useState, useEffect, createContext, useContext, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirestore, collection, doc, getDoc, setDoc, onSnapshot, deleteDoc, addDoc, serverTimestamp, query, orderBy, limit } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// --- Contexto e Provedor Firebase ---
// Definindo um valor padrão mais robusto para o contexto para evitar erros de desestruturação
const AppContext = createContext({
    app: null,
    db: null,
    auth: null,
    storage: null,
    userId: null,
    userEmail: null,
    user: null,
    loadingFirebase: true,
    isAdmin: false,
    currentAppId: 'acai-app-prod', // Valor padrão fixo
    authErrorMessage: '',
    isAuthReady: false,
    productsData: [],
    toppingsData: [],
    loadingProductsAndToppings: true,
    message: '', // Manter message e messageType para a MessageBox, mas showMessage não será mais chamado
    messageType: 'success',
    showMessage: () => {}, // A função showMessage não fará nada visível
    handleCloseMessage: () => {},
    handleLogout: () => {}, // Adicionado handleLogout ao contexto
});

// Componente provedor que inicializa o Firebase e gerencia estados globais.
const AppProvider = ({ children }) => {
    const [app, setApp] = useState(null);
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [storage, setStorage] = useState(null);
    const [userId, setUserId] = useState(null);
    const [userEmail, setUserEmail] = useState(null);
    const [user, setUser] = useState(null);
    const [loadingFirebase, setLoadingFirebase] = useState(true);
    const [isAdmin, setIsAdmin] = useState(false);
    const [currentAppId, setCurrentAppId] = useState(''); // Será definido pelo projectId
    const [authErrorMessage, setAuthErrorMessage] = useState('');
    const [isAuthReady, setIsAuthReady] = useState(false);
    // NOVO ESTADO: Para armazenar o ID do usuário anônimo quando ele é carregado pela primeira vez
    const anonymousUserIdOnLoad = useRef(null);

    const [productsData, setProductsData] = useState([]);
    const [toppingsData, setToppingsData] = useState([]);
    const [loadingProductsAndToppings, setLoadingProductsAndToppings] = useState(true);
    const [message, setMessage] = useState(''); // Manter para a MessageBox, mas não será preenchido por showMessage
    const [messageType, setMessageType] = useState('success');

    const previousUserRef = useRef(null);
    // showMessage agora apenas loga no console, não exibe mensagem visível
    const showMessage = (msg, type = 'success') => {
        if (type === 'error') {
            console.error(`ERRO (showMessage): ${msg}`);
        } else {
            console.log(`INFO (showMessage): ${msg}`);
        }
        // Não define message/messageType para evitar a MessageBox
        // setMessage(msg);
        // setMessageType(type);
        // setTimeout(() => {
        //     setMessage('');
        //     setMessageType('success');
        // }, 3000);
    };

    const handleCloseMessage = () => {
        setMessage('');
        setMessageType('success');
    };
    const migrateAnonymousCartInternal = async (dbInstance, appId, anonId, authId, showMsgFunc) => {
        if (!anonId || !authId || anonId === authId || !dbInstance || !appId) {
            console.log("Condições inválidas para migração de carrinho (IDs ausentes, IDs iguais ou DB/AppId não prontos).");
            return;
        }

        try {
            const anonCartDocRef = doc(dbInstance, 'artifacts', appId, 'users', anonId, 'cart', 'currentCart');
            const anonCartSnapshot = await getDoc(anonCartDocRef);
            const anonCartItems = anonCartSnapshot.exists() ? anonCartSnapshot.data().items : [];
            console.log("DEBUG: Carrinho anônimo lido:", anonCartItems); // DEBUG LOG
            if (anonCartItems.length === 0) {
                console.log("Nenhum carrinho anônimo para migrar.");
                return;
            }

            const authCartDocRef = doc(dbInstance, 'artifacts', appId, 'users', authId, 'cart', 'currentCart');
            const authCartSnapshot = await getDoc(authCartDocRef);
            let authCartItems = authCartSnapshot.exists() ? authCartSnapshot.data().items : [];
            // Lógica de unificação do carrinho mais robusta
            const mergedCart = [...authCartItems];
            anonCartItems.forEach(anonItem => {
                // Normaliza para comparação (considerando adicionais e ingredientes padrão)
                const anonItemKey = `${anonItem.id}-${JSON.stringify((anonItem.selectedDefaultIngredients || []).sort())}-${JSON.stringify((anonItem.toppings || []).map(t => t.id).sort())}`;
                const existingAuthItemIndex = mergedCart.findIndex(item => {
                    const authItemKey = `${item.id}-${JSON.stringify((item.selectedDefaultIngredients || []).sort())}-${JSON.stringify((item.toppings || []).map(t => t.id).sort())}`;
                    return authItemKey === anonItemKey;
                });

                if (existingAuthItemIndex > -1) {
                    mergedCart[existingAuthItemIndex].quantity += anonItem.quantity;
                } else {
                    mergedCart.push(anonItem);
                }
            });
            console.log("DEBUG: Carrinho unificado para salvar:", mergedCart); // DEBUG LOG
            await setDoc(authCartDocRef, { items: mergedCart }, { merge: true });
            console.log(`DEBUG: Carrinho do usuário autenticado ${authId} atualizado no Firestore.`); // DEBUG LOG

            // NOVO: Tenta excluir o carrinho anônimo, mas captura erros de permissão graciosamente
            try {
                await deleteDoc(anonCartDocRef);
                console.log(`Carrinho anônimo para ${anonId} excluído.`);
            } catch (deleteError) {
                console.warn(`AVISO: Não foi possível excluir o carrinho anônimo para ${anonId} devido a permissões. O carrinho foi migrado, mas o documento anônimo pode persistir. Erro:`, deleteError);
                // Não é necessário mostrar uma mensagem de erro crítica ao usuário se a migração principal foi bem-sucedida
            }
            
            // showMsgFunc("Seu carrinho foi unificado com sua conta!", "success"); // Removido
            console.log("Seu carrinho foi unificado com sua conta!");

        } catch (error) {
            console.error("Erro CRÍTICO ao unificar o carrinho anônimo (leitura/escrita):", error); // Este erro é para problemas de leitura/escrita
            // showMsgFunc("Erro ao unificar o carrinho após o login.", "error"); // Removido
        }
    };
    // Nova função handleLogout que será exposta pelo contexto
    const handleLogout = useCallback(async () => {
        try {
            if (auth) {
                await signOut(auth);
                // Força a atualização do estado imediatamente para deslogar a UI
                setUser(null);
                setUserId(null);
                setUserEmail(null);
                setIsAdmin(false);
                // showMessage("Você saiu da sua conta.", "success"); // Removido
                console.log("Você saiu da sua conta.");
            } else {
                console.warn("Objeto de autenticação não disponível para logout.");
            }
        } catch (error) {
            console.error("Erro ao sair:", error);
            // showMessage("Erro ao sair. Tente novamente.", "error"); // Removido
        }
    }, [auth]); // Depende apenas de 'auth'

    useEffect(() => {
        try {
            // Seus dados de configuração do Firebase (hardcoded conforme solicitado)
            const firebaseConfig = {
                apiKey: "AIzaSyCaZMRp0RgA9szhZHJfvh4p8Bg60YWSUZw",
                authDomain: "appv-ec0aa.firebaseapp.com",
                projectId: "appv-ec0aa",
                storageBucket: "appv-ec0aa.firebasestorage.app",
                messagingSenderId: "366005480793",
                appId: "1:366005480793:web:7f3b104fb013d5825ff048",
                measurementId: "G-7K52CGG31W"
            };

            const firebaseApp = initializeApp(firebaseConfig);
            const firestoreDb = getFirestore(firebaseApp);
            const firebaseAuth = getAuth(firebaseApp);
            const firebaseStorage = getStorage(firebaseApp);

            setApp(firebaseApp);
            setDb(firestoreDb);
            setAuth(firebaseAuth);
            setStorage(firebaseStorage);
            // Define o currentAppId a partir da configuração fornecida
            const fixedAppId = firebaseConfig.projectId; // Usando projectId como o appId para consistência
            setCurrentAppId(fixedAppId);
            console.log("App de Açaí: Usando appId hardcoded:", fixedAppId);


            const unsubscribeAuth = onAuthStateChanged(firebaseAuth, async (currentUser) => {
                console.log("AppProvider: Auth state changed. CurrentUser UID:", currentUser ? currentUser.uid : "null");
                console.log("AppProvider: previousUserRef.current:", previousUserRef.current);
                console.log("AppProvider: anonymousUserIdOnLoad.current:", anonymousUserIdOnLoad.current);

                // Se o usuário atual é anônimo e ainda não registramos o ID anônimo, faça-o agora.
                if (currentUser && currentUser.isAnonymous && !anonymousUserIdOnLoad.current) {
                    anonymousUserIdOnLoad.current = currentUser.uid;
                    console.log("AppProvider: anonymousUserIdOnLoad definido como:", anonymousUserIdOnLoad.current);
                }

                // Lógica de migração: se o usuário anterior era anônimo (pelo anonymousUserIdOnLoad)
                // e o usuário atual é autenticado (não anônimo), migre o carrinho.
                if (anonymousUserIdOnLoad.current && currentUser && !currentUser.isAnonymous && anonymousUserIdOnLoad.current !== currentUser.uid) {
                    console.log("DEBUG: Transição de anônimo para autenticado detectada. Anon ID (stored):", anonymousUserIdOnLoad.current, "Auth ID:", currentUser.uid); // DEBUG LOG
                    await migrateAnonymousCartInternal(firestoreDb, fixedAppId, anonymousUserIdOnLoad.current, currentUser.uid, showMessage);
                    console.log("DEBUG: migrateAnonymousCartInternal foi chamada e concluída."); // DEBUG LOG
                    // Limpa o ID anônimo após a migração para evitar migrações duplicadas
                    anonymousUserIdOnLoad.current = null; 
                }

                setUser(currentUser);
                setUserId(currentUser ? currentUser.uid : null);
                setAuthErrorMessage('');

                if (!currentUser && firebaseAuth) {
                    console.log("AppProvider: Nenhum usuário atual, tentando login anônimo.");
                    try {
                        // Não usamos __initial_auth_token aqui, pois você pediu para integrar seu token diretamente
                        await signInAnonymously(firebaseAuth);
                        console.log("AppProvider: Login anônimo bem-sucedido.");
                        setAuthErrorMessage('');
                    } catch (error) {
                        console.error("AppProvider: Erro durante o login anônimo:", error);
                        if (error.code === 'auth/operation-not-allowed') {
                            setAuthErrorMessage('Erro de autenticação: A autenticação anónima não está ativada. Por favor, ative-a na consola do Firebase (Autenticação > Método de início de sessão).');
                        } else {
                            setAuthErrorMessage(`Erro de autenticação: ${error.message}`);
                        }
                    }
                }
                setLoadingFirebase(false);
                setIsAuthReady(true);
                console.log("AppProvider: isAuthReady definido como true. userId:", currentUser ? currentUser.uid : "null");
                previousUserRef.current = currentUser;
            });
            const productsColRef = collection(firestoreDb, 'artifacts', fixedAppId, 'public', 'data', 'products');
            const unsubscribeProducts = onSnapshot(productsColRef, (snapshot) => {
                const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setProductsData(products);
                setLoadingProductsAndToppings(false);
            }, (error) => {
                console.error("Erro ao carregar produtos:", error);
                // Modificado: Se for um erro de permissão, apenas avisa no console, não mostra notificação ao usuário
                if (error.code === 'permission-denied' || error.code === 'unavailable') {
                    console.warn("AVISO: Permissão negada ou serviço indisponível ao carregar produtos. Isso pode ser temporário durante a inicialização/autenticação.");
                } else {
                    // showMessage("Erro ao carregar os produtos do menu. Verifique sua conexão e regras do Firebase.", "error"); // Removido
                }
                setLoadingProductsAndToppings(false);
            });
            // CORREÇÃO: Removido o 'public' duplicado no caminho da coleção de toppings
            const toppingsColRef = collection(firestoreDb, 'artifacts', fixedAppId, 'public', 'data', 'toppings'); 
            const unsubscribeToppings = onSnapshot(toppingsColRef, (snapshot) => {
                const toppings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setToppingsData(toppings);
                setLoadingProductsAndToppings(false);
            }, (error) => {
                console.error("Erro ao carregar adicionais:", error);
                // Modificado: Se for um erro de permissão, apenas avisa no console, não mostra notificação ao usuário
                if (error.code === 'permission-denied' || error.code === 'unavailable') {
                    console.warn("AVISO: Permissão negada ou serviço indisponível ao carregar adicionais. Isso pode ser temporário durante a inicialização/autenticação.");
                } else {
                    // showMessage("Erro ao carregar os adicionais. Verifique sua conexão e regras do Firebase.", "error"); // Removido
                }
                setLoadingProductsAndToppings(false);
            });
            return () => {
                unsubscribeAuth();
                unsubscribeProducts();
                unsubscribeToppings();
            }
        } catch (error) {
            console.error("Erro ao inicializar Firebase:", error);
            setLoadingFirebase(false);
            setAuthErrorMessage(`Erro fatal ao inicializar Firebase: ${error.message}`);
        }
    }, []); // Array de dependências vazio para rodar apenas uma vez.

    // Atualiza userEmail no contexto quando o estado 'user' muda
    useEffect(() => {
        setUserEmail(user ? user.email : null);
        setIsAdmin(user && user.email === 'admin@example.com');
    }, [user]);

    const value = { app, db, auth, storage, userId, userEmail, user, loadingFirebase, isAdmin, currentAppId, authErrorMessage, showMessage, message, messageType, handleCloseMessage, isAuthReady, productsData, toppingsData, loadingProductsAndToppings, handleLogout }; // handleLogout exposto

    return (
        <AppContext.Provider value={value}>
            {children}
        </AppContext.Provider>
    );
};

const useAppContext = () => {
    return useContext(AppContext);
};
const LoadingSpinner = () => (
    <div className="flex justify-center items-center h-screen bg-gradient-to-br from-teal-800 to-green-900 p-4">
        <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-white"></div>
        <p className="ml-4 text-lg text-white font-semibold">Carregando...</p>
    </div>
);
const MessageBox = ({ message, type, onClose }) => {
    // Este componente agora não será mais ativado pelas chamadas showMessage
    useEffect(() => {
        if (message) {
            const timer = setTimeout(() => {
                onClose();
            }, 3000);
            return () => clearTimeout(timer);
        }
    }, [message, onClose]);

    if (!message) return null;

    const bgColor = type === 'error' ? 'bg-red-100 border-red-400 text-red-700' : 'bg-green-100 border-green-400 text-green-700';
    return (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 px-4 py-3 rounded-md shadow-lg border ${bgColor} z-50`} role="alert">
            <div className="flex items-center justify-between">
                <span className="block sm:inline">{message}</span>
                <button onClick={onClose} className="ml-4 text-xl font-bold leading-none">&times;</button>
            </div>
        </div>
    );
};

// Componente de Modal de Confirmação customizado
const ConfirmationModal = ({ message, onConfirm, onCancel }) => {
    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm text-center">
                <p className="text-lg font-semibold text-gray-800 mb-6">{message}</p>
                <div className="flex justify-center space-x-4">
                    <button
                        onClick={onCancel}
                        className="bg-gray-300 hover:bg-gray-400 text-gray-800 font-bold py-2 px-5 rounded-lg shadow-md transition duration-200"
                    >
                        Cancelar
                    </button>
                    <button
                        onClick={onConfirm}
                        className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-5 rounded-lg shadow-md transition duration-200"
                    >
                        Confirmar
                    </button>
                </div>
            </div>
        </div>
    );
};

const Navbar = ({ currentPage, onNavigate, onLogout, userEmail }) => {
    // Estado para controlar a exibição do modal de confirmação de logout
    const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

    const handleLogoutClick = () => {
        setShowLogoutConfirm(true);
    };

    const handleConfirmLogout = () => {
        setShowLogoutConfirm(false);
        onLogout(); // Chama a função de logout passada via props
    };

    const handleCancelLogout = () => {
        setShowLogoutConfirm(false);
        console.log("Logout cancelado pelo usuário.");
    };

    return (
        <nav className="fixed bottom-0 left-0 right-0 w-full bg-white shadow-lg z-50">
            <div className="flex items-center justify-around h-16"> {/* Adjust height as needed */}
                {/* Menu Icon */}
                <div
                    onClick={() => onNavigate('home')}
                    className={`flex flex-col items-center justify-center p-2 cursor-pointer transition-colors duration-200
                        ${currentPage === 'home' ? 'text-purple-600' : 'text-gray-500 hover:text-purple-500'}`}
                >
                    <div className={`${currentPage === 'home' ? 'bg-purple-100 border-2 border-purple-600 rounded-full p-2' : ''}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001 1h2a1 1 0 001-1m-6 0v-4a1 1 0 011-1h2a1 1 0 011 1v4m-6 0h4" />
                        </svg>
                    </div>
                    <span className="text-xs mt-1">Menu</span>
                </div>

                {/* Carrinho Icon */}
                <div
                    onClick={() => onNavigate('cart')}
                    className={`flex flex-col items-center justify-center p-2 cursor-pointer transition-colors duration-200
                        ${currentPage === 'cart' ? 'text-teal-600' : 'text-gray-500 hover:text-teal-500'}`}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.182 1.769.707 1.769H19m-9 3a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z" />
                    </svg>
                    <span className="text-xs mt-1">Carrinho</span>
                </div>

                {/* Pedidos Icon */}
                <div
                    onClick={() => onNavigate('my-orders')}
                    className={`flex flex-col items-center justify-center p-2 cursor-pointer transition-colors duration-200
                        ${currentPage === 'my-orders' ? 'text-teal-600' : 'text-gray-500 hover:text-teal-500'}`}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                    </svg>
                    <span className="text-xs mt-1">Pedidos</span>
                </div>

                {/* Perfil Icon */}
                {userEmail && (
                    <div
                        onClick={() => onNavigate('profile')}
                        className={`flex flex-col items-center justify-center p-2 cursor-pointer transition-colors duration-200
                            ${currentPage === 'profile' ? 'text-teal-600' : 'text-gray-500 hover:text-teal-500'}`}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                        <span className="text-xs mt-1">Perfil</span>
                    </div>
                )}
            </div>
            {showLogoutConfirm && (
                <ConfirmationModal
                    message="Tem certeza que deseja sair?"
                    onConfirm={handleConfirmLogout}
                    onCancel={handleCancelLogout}
                />
            )}
        </nav>
    );
};

const FloatingCartButton = ({ totalItems, totalPrice, onNavigateToCart, currentPage }) => {
    // Esconder o botão em páginas específicas ou se o carrinho estiver vazio
    if (totalItems === 0 || ['cart', 'profile', 'product-details', 'my-orders', 'order-finalization', 'checkout-payment'].includes(currentPage)) {
        return null;
    }

    return (
        <button
            // Alterado de top-0 para bottom-16 para posicionar acima da navbar
            // Alterado de rounded-b-2xl para rounded-t-2xl para arredondar a parte superior
            onClick={onNavigateToCart}
            className="fixed bottom-16 left-0 right-0 bg-yellow-500 hover:bg-yellow-600 text-gray-900 font-extrabold py-3 px-4 sm:py-4 sm:px-6 rounded-t-2xl sm:rounded-t-3xl shadow-lg transition duration-300 ease-in-out transform hover:scale-105 flex items-center justify-between z-40 w-full max-w-sm sm:max-w-md mx-auto"
            style={{ borderRadius: '1.5rem 1.5rem 0 0' }} // Ajuste manual para garantir o arredondamento superior
        >
            <div className="flex items-center space-x-1 sm:space-x-2">
                <span className="bg-white text-teal-700 text-xs sm:text-sm font-bold px-2 py-1 rounded-full">{totalItems}</span>
                <span className="text-base sm:text-lg">Ver meu pedido</span>
            </div>
            <span className="text-lg sm:text-xl">R$ {totalPrice.toFixed(2)}</span>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 sm:h-6 sm:w-6 transform rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
        </button>
    );
};

const CustomizeAcaiModal = ({ product, onClose, onCompleteCustomization, initialToppings = [], initialQuantity = 1, initialSelectedDefaultIngredients = [] }) => {
    const { toppingsData } = useAppContext();
    const availableToppings = toppingsData;

    const [selectedIncludedIngredients, setSelectedIncludedIngredients] = useState(initialSelectedDefaultIngredients.length > 0 ? [...initialSelectedDefaultIngredients] : (Array.isArray(product.defaultIngredients) ? [...product.defaultIngredients] : []));
    const [selectedToppings, setSelectedToppings] = useState(initialToppings.map(t => t.id));
    const [quantity, setQuantity] = useState(initialQuantity);

    const calculateItemBasePrice = () => {
        const toppingsPrice = selectedToppings.reduce((sum, toppingId) => {
            const topping = availableToppings.find(t => t.id === toppingId);
            return sum + (topping ? topping.price : 0);
        }, 0);
        return product.price + toppingsPrice;
    };

    const handleIncludedIngredientChange = (ingredientName) => {
        setSelectedIncludedIngredients(prev =>
            prev.includes(ingredientName)
                ? prev.filter(name => name !== ingredientName)
                : [...prev, ingredientName]
        );
    };

    const handleToppingChange = (toppingId) => {
        setSelectedToppings(prev =>
            prev.includes(toppingId)
                ? prev.filter(id => id !== toppingId)
                : [...prev, toppingId]
        );
    };

    const handleCompleteAction = () => {
        const addedToppings = selectedToppings.map(toppingId => availableToppings.find(t => t.id === toppingId)).filter(Boolean);

        const cartItemId = `${product.id}-${JSON.stringify(selectedIncludedIngredients.sort())}-${JSON.stringify(selectedToppings.sort())}`;

        const customizedProduct = {
            ...product,
            selectedDefaultIngredients: selectedIncludedIngredients,
            toppings: addedToppings,
            quantity: quantity,
            basePrice: calculateItemBasePrice(),
            cartItemId: cartItemId
        };
        onCompleteCustomization(customizedProduct);
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm sm:max-w-md max-h-[90vh] overflow-y-auto">
                <div className="flex justify-between items-center mb-6 border-b pb-4">
                    <h3 className="text-xl sm:text-2xl font-bold text-gray-800">Personalizar {product.name}</h3>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-3xl font-bold">&times;</button>
                </div>

                <div className="mb-6">
                    {product.defaultIngredients && product.defaultIngredients.length > 0 && (
                        <div className="mb-4 p-3 sm:p-4 bg-gray-100 rounded-lg">
                            <h4 className="text-base sm:text-xl font-semibold text-gray-700 mb-2">Ingredientes Padrão (remova se não quiser):</h4>
                            <div className="space-y-2">
                                {product.defaultIngredients.map((ingredient, index) => (
                                    <label key={index} className="flex items-center text-sm sm:text-lg text-gray-700 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={selectedIncludedIngredients.includes(ingredient)}
                                            onChange={() => handleIncludedIngredientChange(ingredient)}
                                            className="form-checkbox h-4 w-4 sm:h-5 sm:w-5 text-teal-600 rounded mr-2 sm:mr-3"
                                        />
                                        {ingredient}
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}

                    <h4 className="text-base sm:text-xl font-semibold text-gray-700 mb-3 mt-6">Adicionais Pagos:</h4>
                    <div className="space-y-2">
                        {availableToppings.filter(t => !t.isOutOfStock).map(topping => (
                            <label key={topping.id} className="flex items-center text-sm sm:text-lg text-gray-700 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={selectedToppings.includes(topping.id)}
                                    onChange={() => handleToppingChange(topping.id)}
                                    className="form-checkbox h-4 w-4 sm:h-5 sm:w-5 text-teal-600 rounded mr-2 sm:mr-3"
                                />
                                {topping.name} (R$ {topping.price.toFixed(2)})
                            </label>
                        ))}
                    </div>
                </div>

                <div className="flex flex-col sm:flex-row items-center justify-between mt-6 pt-4 border-t space-y-4 sm:space-y-0">
                    <div className="flex items-center space-x-3">
                        <button
                            onClick={() => setQuantity(prev => Math.max(1, prev - 1))}
                            className="bg-gray-200 text-gray-700 font-bold py-1 px-3 rounded-full hover:bg-gray-300 transition text-base"
                        >
                            -
                        </button>
                        <span className="text-lg sm:text-xl font-semibold">{quantity}</span>
                        <button
                            onClick={() => setQuantity(prev => prev + 1)}
                            className="bg-gray-200 text-gray-700 font-bold py-1 px-3 rounded-full hover:bg-gray-300 transition text-base"
                        >
                            +
                        </button>
                    </div>
                    <button
                        onClick={handleCompleteAction}
                        className="bg-teal-600 hover:bg-teal-700 text-white font-bold py-2 px-4 sm:py-3 sm:px-6 rounded-xl shadow-md transition duration-200 ease-in-out transform hover:scale-105 text-base sm:text-lg"
                    >
                        Confirmar (R$ {(calculateItemBasePrice() * quantity).toFixed(2)})
                    </button>
                </div>
            </div>
        </div>
    );
};

const AuthScreen = ({ onLoginSuccess, onClose }) => {
    const { auth, authErrorMessage } = useAppContext(); // showMessage removido
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isRegister, setIsRegister] = useState(true); // Começa em modo de registro
    const [authLoading, setAuthLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setAuthLoading(true);
        try {
            if (!auth) {
                console.error("Erro de inicialização do Firebase Auth."); // showMessage removido
                setAuthLoading(false);
                return;
            }
            if (isRegister) {
                await createUserWithEmailAndPassword(auth, email, password);
                console.log("Cadastro realizado com sucesso! Agora você pode finalizar seu pedido."); // showMessage removido
                onLoginSuccess(); // Chamando a função de sucesso para fechar o modal
            } else {
                await signInWithEmailAndPassword(auth, email, password);
                console.log("Login realizado com sucesso! Agora você pode finalizar seu pedido."); // showMessage removido
                onLoginSuccess(); // Chamando a função de sucesso para fechar o modal
            }
        } catch (error) {
            let errorMessage = "Ocorreu um erro na autenticação.";
            if (error.code === 'auth/email-already-in-use') {
                errorMessage = "Este e-mail já está em uso.";
            } else if (error.code === 'auth/invalid-email') {
                errorMessage = "E-mail inválido.";
            } else if (error.code === 'auth/weak-password') {
                errorMessage = "A senha é muito fraca (mínimo 6 caracteres).";
            } else if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
                errorMessage = "E-mail ou senha incorretos.";
            } else if (error.code === 'auth/too-many-requests') {
                errorMessage = "Muitas tentativas de login. Tente novamente mais tarde.";
            }
            console.error("Erro de autenticação:", error.code, errorMessage); // showMessage removido
        } finally {
            setAuthLoading(false);
        }
    };

    return (
        <div className="bg-white p-8 rounded-xl shadow-2xl w-full max-w-md relative">
            <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-gray-700 text-3xl font-bold">&times;</button>
            <h2 className="text-3xl font-bold text-center text-gray-800 mb-2">
                Registre-se
            </h2>
            <p className="text-center text-gray-600 text-sm mb-6">para acompanhar seu pedido</p>
            <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                    <label className="block text-gray-700 text-sm font-semibold mb-2" htmlFor="email">
                        E-mail
                    </label>
                    <input
                        type="email"
                        id="email"
                        className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 transition duration-200"
                        placeholder="seu@email.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                    />
                </div>
                <div>
                    <label className="block text-gray-700 text-sm font-semibold mb-2" htmlFor="password">
                        Senha
                    </label>
                    <input
                        type="password"
                        id="password"
                        className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 transition duration-200"
                        placeholder="Sua senha"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                    />
                </div>
                <button
                    type="submit"
                    className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold py-3 px-4 rounded-lg shadow-md transition duration-300 ease-in-out transform hover:scale-105 disabled:opacity-50"
                    disabled={authLoading}
                >
                    {authLoading ? 'Carregando...' : (isRegister ? 'Cadastrar' : 'Entrar')}
                </button>
            </form>
            <p className="mt-6 text-center text-gray-600">
                {isRegister ? (
                    <>Já tem uma conta?{' '}
                        <button
                            type="button"
                            onClick={() => setIsRegister(false)}
                            className="text-green-600 hover:underline font-semibold focus:outline-none"
                        >
                            Entre
                        </button>
                    </>
                ) : (
                    <>Não tem uma conta?{' '}
                        <button
                            type="button"
                            onClick={() => setIsRegister(true)}
                            className="text-teal-600 hover:underline font-semibold focus:outline-none"
                        >
                            Crie uma
                        </button>
                    </>
                )}
            </p>
            {authErrorMessage && <p className="text-red-500 text-sm mt-4 text-center">{authErrorMessage}</p>}
        </div>
    );
};

const ProductList = ({ onSelectProduct }) => {
    const { productsData, loadingProductsAndToppings } = useAppContext();

    if (loadingProductsAndToppings) {
        return <LoadingSpinner />;
    }

    if (productsData.length === 0) {
        return (
            <div className="p-4 sm:p-6 bg-teal-100 min-h-screen flex flex-col items-center justify-center text-center">
                <p className="text-gray-700 text-lg sm:text-xl mb-4">Nenhum produto encontrado no menu.</p>
                <p className="text-gray-600 text-md mb-6">Por favor, adicione produtos no seu Firebase Firestore no caminho:</p>
                <p className="font-mono text-sm sm:text-base text-gray-800 bg-gray-200 p-2 rounded-md break-all">
                    /artifacts/appv-ec0aa/public/data/products
                </p>
                <p className="text-gray-600 text-md mt-6">Use o painel de administração para adicionar produtos.</p>
            </div>
        );
    };

    const renderProductSection = (type, title) => {
        const filteredProducts = productsData.filter(p => p.type === type && !p.isOutOfStock);
        if (filteredProducts.length === 0) {
            return null;
        }
        return (
            <>
                <h3 className="text-2xl sm:text-3xl font-bold text-teal-700 text-center mb-6 mt-8">{title}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8 max-w-6xl mx-auto">
                    {filteredProducts.map(product => (
                        <div
                            key={product.id}
                            className="bg-white rounded-2xl shadow-xl overflow-hidden transform transition duration-300 hover:scale-105 flex flex-col items-center p-4 sm:p-6 cursor-pointer"
                            onClick={() => onSelectProduct(product)}
                        >
                            <img src={product.image} alt={product.name} className="w-32 h-32 sm:w-40 sm:h-40 object-cover rounded-full mb-3 sm:mb-4 border-2 sm:border-4 border-teal-300" onError={(e) => e.target.src = 'https://placehold.co/160x160/cccccc/000000?text=Sem+Imagem'}/>
                            <h3 className="text-xl sm:text-2xl font-semibold text-gray-800 mb-1 sm:mb-2">{product.name}</h3>
                            <p className="text-lg sm:text-xl text-teal-600 font-bold mb-3 sm:mb-4">R$ {product.price.toFixed(2)}</p>
                            <span className="text-blue-600 hover:underline text-sm sm:text-base">Ver Detalhes</span>
                        </div>
                    ))}
                </div>
            </>
        );
    };

    return (
        <div className="p-4 sm:p-6 bg-teal-100 min-h-screen pb-32"> {/* Changed from pb-24 to pb-32 */}
            {/* Removido o h1 do appaçaí daqui */}
            <h2 className="text-3xl sm:text-4xl font-extrabold text-gray-900 text-center mb-8 sm:mb-10">Nosso Menu</h2>

            {renderProductSection('acai', 'Açaís')}
            {renderProductSection('bebida', 'Bebidas')}
            {renderProductSection('sorvete', 'Sorvetes & Outros')}
            {renderProductSection('coxinha', 'Coxinhas')}

        </div>
    );
};

const ProductDetailPage = ({ product, onAddToCart, onNavigateBack }) => {
    const [showCustomizeModal, setShowCustomizeModal] = useState(false);
    const [currentCustomizedProduct, setCurrentCustomizedProduct] = useState(null);

    useEffect(() => {
        if (product) {
            setCurrentCustomizedProduct({
                ...product,
                quantity: 1,
                selectedDefaultIngredients: Array.isArray(product.defaultIngredients) ? [...product.defaultIngredients] : [],
                toppings: [],
                basePrice: product.price
            });
        }
    }, [product]);

    const handleOpenCustomizeModal = () => {
        setShowCustomizeModal(true);
    };

    const handleCloseCustomizeModal = () => {
        setShowCustomizeModal(false);
    };

    const handleCompleteCustomization = (customizedProductData) => {
        setCurrentCustomizedProduct(customizedProductData);
        handleCloseCustomizeModal();
    };

    const handleAddToCartClick = () => {
        if (currentCustomizedProduct) {
            onAddToCart(currentCustomizedProduct);
            onNavigateBack();
        }
    };

    if (!product || !currentCustomizedProduct) {
        return <LoadingSpinner />;
    }

    if (product.type !== 'acai') {
        return (
            <div className="p-4 sm:p-6 bg-teal-100 min-h-screen flex flex-col items-center justify-center text-center pb-32"> {/* Changed from pb-24 to pb-32 */}
                <button
                    onClick={onNavigateBack}
                    className="absolute top-4 left-4 mb-4 sm:mb-6 flex items-center text-teal-600 hover:text-teal-800 font-semibold text-sm sm:text-base"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5 mr-1 sm:mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Voltar para Menu
                </button>
                <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-3 sm:mb-4">{product.name}</h2>
                <img src={product.image} alt={product.name} className="w-32 h-32 sm:w-40 sm:h-40 object-cover rounded-full mb-3 sm:mb-4 border-2 sm:border-4 border-teal-300" onError={(e) => e.target.src = 'https://placehold.co/160x160/cccccc/000000?text=Sem+Imagem'}/>
                <p className="text-lg sm:text-xl text-teal-600 font-bold mb-3 sm:mb-4">R$ {product.price.toFixed(2)}</p>
                <p className="text-sm sm:text-lg text-gray-700 mb-4 sm:mb-6">{product.description}</p>
                <button
                    onClick={() => onAddToCart({ ...product, quantity: 1, selectedDefaultIngredients: [], toppings: [], basePrice: product.price, cartItemId: `${product.id}-default` })}
                    className="bg-yellow-500 hover:bg-yellow-600 text-gray-900 font-bold py-2 px-6 sm:py-3 sm:px-8 rounded-xl shadow-md transition duration-200 ease-in-out transform hover:scale-105 text-base sm:text-lg"
                >
                    Adicionar ao Carrinho
                </button>
            </div>
        );
    }

    return (
        <div className="p-4 sm:p-6 bg-teal-100 min-h-screen pb-32"> {/* Changed from pb-24 to pb-32 */}
            <button
                onClick={onNavigateBack}
                className="mb-4 sm:mb-6 flex items-center text-teal-600 hover:text-teal-800 font-semibold text-sm sm:text-base"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5 mr-1 sm:mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Voltar para Menu
            </button>

            <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-xl p-6 sm:p-8 flex flex-col items-center">
                <img src={currentCustomizedProduct.image} alt={currentCustomizedProduct.name} className="w-48 h-48 sm:w-60 sm:h-60 object-cover rounded-full mb-4 sm:mb-6 border-2 sm:border-4 border-teal-400" onError={(e) => e.target.src = 'https://placehold.co/160x160/cccccc/000000?text=Sem+Imagem'}/>
                <h2 className="text-3xl sm:text-4xl font-extrabold text-gray-900 mb-2 sm:mb-4">{currentCustomizedProduct.name}</h2>
                <p className="text-lg sm:text-xl text-teal-600 font-bold mb-3 sm:mb-4">
                    R$ ${(currentCustomizedProduct.basePrice * currentCustomizedProduct.quantity).toFixed(2)}
                </p>
                <p className="text-sm sm:text-lg text-gray-700 text-center mb-4 sm:mb-6">{currentCustomizedProduct.description}</p>

                {currentCustomizedProduct.selectedDefaultIngredients && currentCustomizedProduct.selectedDefaultIngredients.length > 0 && (
                    <div className="mb-3 sm:mb-4 w-full">
                        <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2 sm:mb-3">Inclui:</h3>
                        <ul className="list-disc list-inside text-sm sm:text-lg text-gray-700">
                            {currentCustomizedProduct.selectedDefaultIngredients.map((ingredient, index) => (
                                <li key={index}>{ingredient}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {currentCustomizedProduct.toppings && currentCustomizedProduct.toppings.length > 0 && (
                    <div className="mb-4 sm:mb-6 w-full">
                        <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2 sm:mb-3">Adicionais:</h3>
                        <ul className="list-disc list-inside text-sm sm:text-lg text-gray-700">
                            {currentCustomizedProduct.toppings.map((topping, index) => (
                                <li key={index}>{topping.name} (R$ {topping.price.toFixed(2)})</li>
                            ))}
                        </ul>
                    </div>
                )}

                <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-4 mt-3 sm:mt-4 w-full justify-center">
                    <button
                        onClick={handleOpenCustomizeModal}
                        className="bg-teal-600 hover:bg-teal-700 text-white font-bold py-2 px-6 sm:py-3 sm:px-8 rounded-xl shadow-md transition duration-200 ease-in-out transform hover:scale-105 text-base sm:text-lg"
                    >
                        Personalizar Pedido
                    </button>
                    <button
                        onClick={handleAddToCartClick}
                        className="bg-yellow-500 hover:bg-yellow-600 text-gray-900 font-bold py-2 px-6 sm:py-3 sm:px-8 rounded-xl shadow-md transition duration-200 ease-in-out transform hover:scale-105 text-base sm:text-lg"
                    >
                        Adicionar ao Carrinho
                    </button>
                </div>
            </div>

            {showCustomizeModal && (
                <CustomizeAcaiModal
                    product={product}
                    onClose={handleCloseCustomizeModal}
                    onCompleteCustomization={handleCompleteCustomization}
                    initialQuantity={currentCustomizedProduct.quantity}
                    initialToppings={currentCustomizedProduct.toppings}
                    initialSelectedDefaultIngredients={currentCustomizedProduct.selectedDefaultIngredients}
                />
            )}
        </div>
    );
};

// NOVO COMPONENTE: RecommendedProducts
const RecommendedProducts = ({ cartItems, onAddToCart }) => {
    const { productsData, loadingProductsAndToppings } = useAppContext();
    const [recommended, setRecommended] = useState([]);

    useEffect(() => {
        if (loadingProductsAndToppings || !productsData.length) {
            return;
        }

        // IDs dos itens já no carrinho para evitar duplicatas
        const cartProductIds = new Set(cartItems.map(item => item.id));

        // Filtra produtos que não são açaí e não estão no carrinho, e que não estão fora de estoque
        const eligibleProducts = productsData.filter(product =>
            product.type !== 'acai' &&
            !cartProductIds.has(product.id) &&
            !product.isOutOfStock
        );

        // Seleciona aleatoriamente até 3 produtos para recomendação
        const shuffled = eligibleProducts.sort(() => 0.5 - Math.random());
        setRecommended(shuffled.slice(0, 3));
    }, [productsData, loadingProductsAndToppings, cartItems]);

    if (recommended.length === 0) {
        return null;
    }

    return (
        <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl p-6 sm:p-8 mt-8">
            <h3 className="text-xl sm:text-2xl font-bold text-gray-900 mb-6 text-center">Outros clientes também compraram:</h3>
            {/* Adicionado overflow-x-auto e flex flex-nowrap para permitir o scroll horizontal */}
            <div className="flex flex-nowrap overflow-x-auto gap-6 pb-4"> {/* Adicionado pb-4 para evitar que a barra de rolagem cubra o conteúdo */}
                {recommended.map(product => (
                    <div key={product.id} className="flex-none w-48 flex flex-col items-center text-center p-4 border border-gray-200 rounded-lg shadow-sm">
                        <img src={product.image} alt={product.name} className="w-20 h-20 object-cover rounded-full mb-3 border-2 border-teal-300" onError={(e) => e.target.src = 'https://placehold.co/80x80/cccccc/000000?text=Sem+Imagem'}/>
                        <p className="font-semibold text-md text-gray-800 mb-1">{product.name}</p>
                        <p className="text-teal-600 font-bold text-sm mb-3">R$ {product.price.toFixed(2)}</p>
                        <button
                            onClick={() => onAddToCart({ ...product, quantity: 1, selectedDefaultIngredients: [], toppings: [], basePrice: product.price, cartItemId: `${product.id}-default-${Date.now()}` })}
                            className="bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold py-2 px-3 rounded-full transition duration-200 ease-in-out transform hover:scale-105"
                        >
                            Adicionar
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};


const CartPage = ({ cart, onUpdateCartItem, onRemoveFromCart, onClearCart, onNavigateToFinalization, onNavigateBack, onAddToCart }) => {
    const { showMessage } = useAppContext();
    const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
    const [itemToRemove, setItemToRemove] = useState(null);
    const [showClearCartConfirm, setShowClearCartConfirm] = useState(false);
    
    // NOVO estado para observações
    const [observations, setObservations] = useState('');

    // Estados para o modal de personalização
    const [showCustomizeModal, setShowCustomizeModal] = useState(false);
    const [itemToCustomize, setItemToCustomize] = useState(null);

    const cartTotal = cart.reduce((total, item) => total + (item.basePrice * item.quantity), 0);

    const handleConfirmRemoveItem = (item) => {
        setItemToRemove(item);
        setShowRemoveConfirm(true);
    };

    const handleActualRemoveItem = () => {
        onRemoveFromCart(itemToRemove.cartItemId);
        // showMessage("Item removido do carrinho!", "success"); // Removido
        console.log("Item removido do carrinho!");
        setShowRemoveConfirm(false);
        setItemToRemove(null);
    };

    const handleCancelRemoveItem = () => {
        setShowRemoveConfirm(false);
        setItemToRemove(null);
        console.log("Remoção de item cancelada pelo usuário.");
    };

    const handleConfirmClearCart = () => {
        setShowClearCartConfirm(true);
    };

    const handleActualClearCart = () => {
        onClearCart();
        // showMessage("Carrinho limpo!", "success"); // Removido
        console.log("Carrinho limpo!");
        setShowClearCartConfirm(false);
    };

    const handleCancelClearCart = () => {
        setShowClearCartConfirm(false);
        console.log("Limpeza de carrinho cancelada pelo usuário.");
    };

    const handleProceedToFinalization = () => {
        onNavigateToFinalization({
            cartItems: cart,
            totalPrice: cartTotal,
            observations: observations, // Passa as observações
            deliveryFee: 0 // Assume 0 por enquanto
        });
    };

    // Função para abrir o modal de personalização para um item existente
    const handleOpenCustomizeModal = (item) => {
        setItemToCustomize(item);
        setShowCustomizeModal(true);
    };

    // Função para fechar o modal de personalização
    const handleCloseCustomizeModal = () => {
        setShowCustomizeModal(false);
        setItemToCustomize(null);
    };

    // Função para lidar com a personalização concluída do modal
    const handleCompleteCustomizationFromModal = (customizedProductData) => {
        // Encontra o índice do item original no carrinho para substituí-lo
        const originalItemIndex = cart.findIndex(item => item.cartItemId === customizedProductData.cartItemId);
        if (originalItemIndex > -1) {
            const updatedCart = [...cart];
            updatedCart[originalItemIndex] = customizedProductData;
            onUpdateCartItem(customizedProductData); // Usa a função de atualização existente
        }
        handleCloseCustomizeModal();
    };


    return (
        <div className="p-4 sm:p-6 bg-teal-100 min-h-screen pb-32"> {/* Changed from pb-24 to pb-32 */}
            <button
                onClick={onNavigateBack}
                className="mb-4 sm:mb-6 flex items-center text-teal-600 hover:text-teal-800 font-semibold text-sm sm:text-base"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5 mr-1 sm:mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                Voltar para Menu
            </button>

            <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl p-6 sm:p-8">
                <h2 className="text-3xl sm:text-4xl font-extrabold text-gray-900 text-center mb-8">Seu Carrinho</h2>
                {cart.length === 0 ? (
                    <p className="text-center text-gray-600 text-lg sm:text-xl">Seu carrinho está vazio.</p>
                ) : (
                    <>
                        <ul className="space-y-4 mb-6">
                            {cart.map((item) => (
                                <li key={item.cartItemId} className="flex flex-col sm:flex-row justify-between items-center border-b border-gray-200 pb-4 pt-4 first:pt-0">
                                    <div className="flex items-center w-full sm:w-auto mb-3 sm:mb-0">
                                        <img src={item.image} alt={item.name} className="w-16 h-16 rounded-full object-cover mr-4 border border-gray-200" onError={(e) => e.target.src = 'https://placehold.co/160x160/cccccc/000000?text=Sem+Imagem'}/>
                                        <div className="flex-1">
                                            <p className="font-semibold text-lg sm:text-xl text-gray-800">{item.name}</p>
                                            {item.selectedDefaultIngredients && item.selectedDefaultIngredients.length > 0 && (
                                                <p className="text-gray-600 text-sm">Inclui: {item.selectedDefaultIngredients.join(', ')}</p>
                                            )}
                                            {item.toppings && item.toppings.length > 0 && (
                                                <p className="text-gray-600 text-sm">Adicionais: {item.toppings.map(t => t.name).join(', ')}</p>
                                            )}
                                            <p className="text-teal-600 font-bold text-base">R$ {item.basePrice.toFixed(2)} / un.</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center space-x-3 mt-3 sm:mt-0">
                                        {/* Botões de quantidade e remover */}
                                        <button
                                            onClick={() => onUpdateCartItem({ ...item, quantity: Math.max(1, item.quantity - 1) })}
                                            className="bg-gray-200 text-gray-700 font-bold py-1 px-3 rounded-full hover:bg-gray-300 transition text-base"
                                        >
                                            -
                                        </button>
                                        <span className="text-xl font-bold text-gray-800">{item.quantity}</span>
                                        <button
                                            onClick={() => onUpdateCartItem({ ...item, quantity: item.quantity + 1 })}
                                            className="bg-gray-200 text-gray-700 font-bold py-1 px-3 rounded-full hover:bg-gray-300 transition text-base"
                                        >
                                            +
                                        </button>
                                        <button
                                            onClick={() => handleConfirmRemoveItem(item)}
                                            className="bg-red-500 hover:bg-red-600 text-white py-1 px-3 rounded-full transition duration-300 ease-in-out text-sm"
                                        >
                                            Remover
                                        </button>
                                        {/* Botão Personalizar (apenas para açaís) */}
                                        {item.type === 'acai' && (
                                            <button
                                                onClick={() => handleOpenCustomizeModal(item)}
                                                className="bg-blue-500 hover:bg-blue-600 text-white py-1 px-3 rounded-full transition duration-300 ease-in-out text-sm ml-2"
                                            >
                                                Personalizar
                                            </button>
                                        )}
                                        <p className="text-xl font-extrabold text-green-600 ml-4">R$ ${(item.basePrice * item.quantity).toFixed(2)}</p>
                                    </div>
                                </li>
                            ))}
                        </ul>

                        {/* NOVO CAMPO: Observações do Pedido */}
                        <div className="mb-6 bg-yellow-50 p-4 rounded-lg border border-yellow-200">
                            <h3 className="text-xl font-bold text-gray-900 mb-4 text-center">Observações do Pedido</h3>
                            <textarea
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-yellow-500 transition duration-200 resize-y"
                                rows="3"
                                placeholder="Ex: Não colocar muita calda, tirar a granola, entregar para Maria..."
                                value={observations}
                                onChange={(e) => setObservations(e.target.value)}
                            ></textarea>
                            <p className="text-xs text-gray-500 mt-1">Esta observação será enviada com o seu pedido.</p>
                        </div>
                    </>
                )}
            </div>
            {/* NOVO COMPONENTE DE RECOMENDAÇÕES */}
            {cart.length > 0 && ( // Exibe apenas se houver itens no carrinho
                <RecommendedProducts cartItems={cart} onAddToCart={onAddToCart} />
            )}

            {/* Total e botões de ação movidos para aqui, após as recomendações */}
            {cart.length > 0 && (
                <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl p-6 sm:p-8 mt-8">
                    <div className="flex justify-between items-center text-2xl sm:text-3xl font-bold text-teal-800 border-t border-gray-300 pt-4 mt-4">
                        <span>Total:</span>
                        <span>R$ {cartTotal.toFixed(2)}</span>
                    </div>
                    <div className="flex flex-col sm:flex-row justify-center mt-6 space-y-3 sm:space-y-0 sm:space-x-4">
                        <button
                            onClick={() => onNavigate('home')} // Volta para o menu
                            className="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3 px-8 rounded-full transition duration-300 ease-in-out transform hover:scale-105 shadow-md text-base w-full sm:w-auto"
                        >
                            Adicionar mais itens
                        </button>
                        <button
                            onClick={handleProceedToFinalization} // Chama handleCheckout do App
                            className="bg-yellow-500 hover:bg-yellow-600 text-gray-900 font-semibold py-3 px-8 rounded-full transition duration-300 ease-in-out transform hover:scale-105 shadow-md text-base w-full sm:w-auto"
                        >
                            Próximo
                        </button>
                    </div>
                </div>
            )}

            {showRemoveConfirm && (
                <ConfirmationModal
                    message={`Tem certeza que deseja remover ${itemToRemove?.name} do carrinho?`}
                    onConfirm={handleActualRemoveItem}
                    onCancel={handleCancelRemoveItem}
                />
            )}
            {showClearCartConfirm && (
                <ConfirmationModal
                    message="Tem certeza que deseja limpar todo o carrinho?"
                    onConfirm={handleActualClearCart}
                    onCancel={handleCancelClearCart}
                />
            )}

            {showCustomizeModal && itemToCustomize && (
                <CustomizeAcaiModal
                    product={itemToCustomize}
                    onClose={handleCloseCustomizeModal}
                    onCompleteCustomization={handleCompleteCustomizationFromModal}
                    initialQuantity={itemToCustomize.quantity}
                    initialToppings={itemToCustomize.toppings}
                    initialSelectedDefaultIngredients={itemToCustomize.selectedDefaultIngredients}
                />
            )}
        </div>
    );
};

// NOVO COMPONENTE: OrderFinalization (Finalização de Pedido)
const OrderFinalization = ({ cart, onNavigate, onShowAuthScreen, setOrderDetailsForCheckout, orderDetails }) => {
    const { userId, userEmail, db, currentAppId, user } = useAppContext(); // showMessage removido
    
    // Estados para os campos do formulário
    const [cep, setCep] = useState('');
    const [rua, setRua] = useState('');
    const [numero, setNumero] = useState('');
    const [bairro, setBairro] = useState('');
    const [pontoReferencia, setPontoReferencia] = useState('');
    const [whatsapp, setWhatsapp] = useState('');
    const [paymentMethod, setPaymentMethod] = useState('pix');

    const cartTotal = cart.reduce((total, item) => total + (item.basePrice * item.quantity), 0);
    const deliveryFee = 0.00; // Taxa de entrega simulada
    const totalToPay = cartTotal + deliveryFee;

    // Carrega dados do perfil se o usuário estiver logado
    useEffect(() => {
        if (user && db && currentAppId && userId) {
            const userProfileDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'profile', 'details');
            const unsubscribe = onSnapshot(userProfileDocRef, (docSnapshot) => {
                if (docSnapshot.exists()) {
                    const data = docSnapshot.data();
                    // Garante que todos os campos sejam strings, mesmo que undefined no Firestore
                    setCep(data.address?.cep || '');
                    setRua(data.address?.street || '');
                    setNumero(data.address?.number || '');
                    setBairro(data.address?.neighborhood || '');
                    setPontoReferencia(data.address?.reference || '');
                    setWhatsapp(data.phone || '');
                }
            }, (error) => {
                console.error("Erro ao carregar dados do perfil:", error); // showMessage removido
            });
            return () => unsubscribe();
        }
    }, [user, db, currentAppId, userId]); // showMessage removido das dependências


    const handleProceedToAuth = async (e) => {
        e.preventDefault();

        // Validação básica dos campos obrigatórios
        if (!whatsapp || !cep || !rua || !numero || !bairro) {
            console.error("Por favor, preencha todos os campos obrigatórios (WhatsApp e Endereço)."); // showMessage removido
            return;
        }

        // Salva os detalhes do pedido no estado do App (ou passa via props para CheckoutPage)
        const orderDetailsToPass = {
            // Cópia explícita dos campos do pedido, garantindo que não há 'undefined'
            cartItems: cart, // Sempre usa o carrinho atual da página
            totalPrice: cartTotal, // Sempre usa o total atual da página
            observations: orderDetails?.observations || '', // Usa as observações que vieram do CartPage, se houver, ou string vazia
            deliveryFee: orderDetails?.deliveryFee || 0, // Usa a taxa de entrega que veio do CartPage, se houver, ou 0

            // Adiciona/sobrescreve com os detalhes coletados nesta página
            deliveryAddress: {
                cep: cep || '', 
                rua: rua || '', 
                numero: numero || '', 
                bairro: bairro || '', 
                pontoReferencia: pontoReferencia || ''
            },
            whatsapp: whatsapp || '', 
            paymentMethod: paymentMethod || 'pix', // Garante um método de pagamento padrão
        };
        setOrderDetailsForCheckout(orderDetailsToPass); // Seta no App para ser usado na CheckoutPage

        if (!userEmail) {
            onShowAuthScreen(); // Abre o pop-up de login/registro
        } else {
            // Se já estiver logado, vai direto para a página de checkout
            onNavigate('checkout-payment');
        }
    };

    return (
        <div className="p-4 sm:p-6 bg-teal-100 min-h-screen pb-32"> {/* Changed from pb-24 to pb-32 */}
            <button
                onClick={() => onNavigate('cart')}
                className="mb-4 sm:mb-6 flex items-center text-teal-600 hover:text-teal-800 font-semibold text-sm sm:text-base"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5 mr-1 sm:mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Voltar para Carrinho
            </button>

            <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-xl p-6 sm:p-8">
                <h2 className="text-3xl sm:text-4xl font-extrabold text-gray-900 text-center mb-8">Finalização do Pedido</h2>

                <form onSubmit={handleProceedToAuth} className="space-y-6">
                    {/* Endereço de Entrega */}
                    <div className="bg-purple-50 p-4 sm:p-6 rounded-xl">
                        <h3 className="text-xl sm:text-2xl font-bold text-purple-800 mb-5">Endereço de Entrega</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-gray-700 text-sm font-semibold mb-2" htmlFor="cep">CEP:</label>
                                <input
                                    type="text"
                                    id="cep"
                                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                                    placeholder="Ex: 51021-000"
                                    value={cep}
                                    onChange={(e) => setCep(e.target.value)}
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-gray-700 text-sm font-semibold mb-2" htmlFor="rua">Rua:</label>
                                <input
                                    type="text"
                                    id="rua"
                                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                                    placeholder="Digite a rua" 
                                    value={rua}
                                    onChange={(e) => setRua(e.target.value)} 
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-gray-700 text-sm font-semibold mb-2" htmlFor="numero">Número:</label>
                                <input
                                    type="text"
                                    id="numero"
                                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                                    placeholder="Ex: 1234"
                                    value={numero}
                                    onChange={(e) => setNumero(e.target.value)}
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-gray-700 text-sm font-semibold mb-2" htmlFor="bairro">Bairro:</label>
                                <input
                                    type="text"
                                    id="bairro"
                                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                                    placeholder="Digite o bairro" 
                                    value={bairro}
                                    onChange={(e) => setBairro(e.target.value)} 
                                    required
                                />
                            </div>
                        </div>
                        <div>
                            <label className="block text-gray-700 text-sm font-semibold mb-2 mt-4" htmlFor="pontoReferencia">Ponto de Referência (Opcional):</label>
                            <input
                                type="text"
                                id="pontoReferencia"
                                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                                placeholder="Ex: Ao lado do prédio azul"
                                value={pontoReferencia}
                                onChange={(e) => setPontoReferencia(e.target.value)}
                                />
                            </div>
                        <div className="mt-4">
                            <label className="block text-gray-700 text-sm font-semibold mb-2" htmlFor="whatsapp">Número de WhatsApp (Obrigatório):</label>
                            <input
                                type="tel"
                                id="whatsapp"
                                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                                placeholder="Ex: (XX) XXXXX-XXXX"
                                value={whatsapp}
                                onChange={(e) => setWhatsapp(e.target.value)}
                                required
                            />
                        </div>
                    </div>

                    {/* Forma de Pagamento */}
                    <div className="bg-purple-50 p-4 sm:p-6 rounded-xl">
                        <h3 className="text-xl sm:text-2xl font-bold text-purple-800 mb-5">Forma de Pagamento</h3>
                        <div className="space-y-3">
                            <label className="flex items-center text-lg text-gray-700 cursor-pointer">
                                <input
                                    type="radio"
                                    name="payment"
                                    value="pix"
                                    checked={paymentMethod === 'pix'}
                                    onChange={() => setPaymentMethod('pix')}
                                    className="form-radio h-5 w-5 text-purple-600"
                                />
                                <span className="ml-3 font-semibold">Pix (Simulado)</span>
                            </label>
                            <label className="flex items-center text-lg text-gray-700 cursor-pointer">
                                <input
                                    type="radio"
                                    name="payment"
                                    value="credit_card"
                                    checked={paymentMethod === 'credit_card'}
                                    onChange={() => setPaymentMethod('credit_card')}
                                    className="form-radio h-5 w-5 text-purple-600"
                                />
                                <span className="ml-3 font-semibold">Cartão de Crédito (Simulado)</span>
                            </label>
                             <label className="flex items-center text-lg text-gray-700 cursor-pointer">
                                <input
                                    type="radio"
                                    name="payment"
                                    value="debit_card"
                                    checked={paymentMethod === 'debit_card'}
                                    onChange={() => setPaymentMethod('debit_card')}
                                    className="form-radio h-5 w-5 text-purple-600"
                                />
                                <span className="ml-3 font-semibold">Cartão de Débito (Simulado)</span>
                            </label>
                             <label className="flex items-center text-lg text-gray-700 cursor-pointer">
                                <input
                                    type="radio"
                                    name="payment"
                                    value="cash"
                                    checked={paymentMethod === 'cash'}
                                    onChange={() => setPaymentMethod('cash')}
                                    className="form-radio h-5 w-5 text-purple-600"
                                />
                                <span className="ml-3 font-semibold">Dinheiro (Simulado)</span>
                            </label>
                        </div>
                    </div>

                    {/* Resumo do Pedido e Botão Finalizar */}
                    <div className="bg-white p-4 sm:p-6 rounded-xl shadow-md">
                        <div className="flex justify-between items-center text-lg font-semibold text-gray-700 mb-2">
                            <span>Subtotal:</span>
                            <span>R$ {cartTotal.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between items-center text-lg font-semibold text-gray-700 mb-4 border-b pb-4">
                            <span>Taxa de Entrega:</span>
                            <span>R$ {deliveryFee.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between items-center text-2xl sm:text-3xl font-bold text-purple-800 mb-6">
                            <span>Total a Pagar:</span>
                            <span>R$ {totalToPay.toFixed(2)}</span>
                        </div>
                        <button
                            type="submit"
                            className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-8 rounded-full shadow-md transition duration-300 ease-in-out transform hover:scale-105 disabled:opacity-50"
                            disabled={!whatsapp || !cep || !rua || !numero || !bairro || !paymentMethod} 
                        >
                            Ir para o Login/Cadastro
                        </button>
                        {!whatsapp && (
                             <p className="text-red-500 text-sm text-center mt-4">
                                Por favor, informe seu número de WhatsApp para contato.
                            </p>
                        )}
                        {(!cep || !rua || !numero || !bairro) && (
                            <p className="text-red-500 text-sm text-center mt-4">
                                Por favor, preencha todos os campos de endereço obrigatórios.
                            </p>
                        )}
                         {!paymentMethod && (
                            <p className="text-red-500 text-sm text-center mt-4">
                                Por favor, selecione uma forma de pagamento.
                            </p>
                        )}
                    </div>
                </form>
            </div>
        </div>
    );
};

// NOVO COMPONENTE: CheckoutPage
const CheckoutPage = ({ orderDetails, onNavigate, onClearCart }) => {
    const { userId, userEmail, db, currentAppId, user } = useAppContext();
    const [submittingPayment, setSubmittingPayment] = useState(false);

    // --- NOVOS ESTADOS PARA PIX ---
    const [pixData, setPixData] = useState(null); // Stores { qrCodeBase64, qrCodeText, expirationTime, paymentId, status }
    const [pixLoading, setPixLoading] = useState(false);
    const [pixError, setPixError] = useState('');
    const [countdown, setCountdown] = useState(0); // Time in seconds for expiration
    const countdownIntervalRef = useRef(null); // Ref to store interval ID
    const [showCopyMessage, setShowCopyMessage] = useState(false); // For "Copiado!" message

    // Vercel API URL (IMPORTANTE: Substitua pela sua URL de deploy real na Vercel!)
    const VERCEL_API_URL = "/api/create-pix-payment";


    if (!orderDetails || !orderDetails.cartItems || orderDetails.cartItems.length === 0) {
        console.error("Nenhum pedido para finalizar. Volte ao carrinho.");
        onNavigate('cart');
        return <LoadingSpinner />; // Ou outro fallback
    }

    // --- LÓGICA DE PAGAMENTO ATUALIZADA ---
    const handleProcessPayment = async () => { // Renomeado de handlePaymentComplete
        setSubmittingPayment(true);
        setPixError(''); // Limpa erros anteriores

        if (!userEmail || !userId) {
            console.error("Erro: Usuário não autenticado. Por favor, tente novamente desde o carrinho.");
            setSubmittingPayment(false);
            return;
        }

        // 1. Salva/atualiza o perfil do usuário (sempre feito, independente do método de pagamento)
        try {
            const userProfileDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'profile', 'details');
            await setDoc(userProfileDocRef, {
                name: user?.displayName || user?.email || '',
                email: userEmail,
                phone: orderDetails.whatsapp || '',
                address: {
                    cep: orderDetails.deliveryAddress?.cep || '',
                    street: orderDetails.deliveryAddress?.rua || '',
                    number: orderDetails.deliveryAddress?.numero || '',
                    neighborhood: orderDetails.deliveryAddress?.bairro || '',
                    reference: orderDetails.deliveryAddress?.pontoReferencia || ''
                },
                lastUpdated: serverTimestamp()
            }, { merge: true });
            console.log("Perfil do usuário atualizado com endereço e WhatsApp.");
        } catch (error) {
            console.error("Erro ao atualizar perfil do usuário:", error);
            setSubmittingPayment(false);
            return; // Impede a continuação se o perfil não puder ser salvo
        }

        // 2. Processa o pagamento de acordo com o método selecionado
        if (orderDetails.paymentMethod === 'pix') {
            setPixLoading(true);
            console.log("DEBUG: Tentando gerar PIX. URL da API:", VERCEL_API_URL); // Log da URL
            try {
                const response = await fetch(VERCEL_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        amount: orderDetails.totalPrice,
                        description: `Pedido de Açaí #${orderDetails.whatsapp}`, // Usando whatsapp como parte da descrição para unicidade
                        payerEmail: userEmail,
                        externalReference: `${orderDetails.whatsapp}-${Date.now()}`, // Referência única
                    }),
                });

                console.log("DEBUG: Resposta bruta da API:", response); // Log da resposta bruta
                const data = await response.json();
                console.log("DEBUG: Dados JSON da resposta da API:", data); // Log dos dados JSON

                if (response.ok && data.qrCodeBase64) {
                    setPixData(data);
                    // Salva o pedido no Firestore com os detalhes do PIX gerado
                    const orderData = {
                        userId: userId,
                        userEmail: userEmail || 'anonimo@example.com',
                        items: orderDetails.cartItems,
                        total: orderDetails.totalPrice,
                        status: 'Aguardando Pagamento PIX', // Novo status para PIX
                        timestamp: serverTimestamp(),
                        deliveryAddress: orderDetails.deliveryAddress,
                        whatsapp: orderDetails.whatsapp,
                        paymentMethod: orderDetails.paymentMethod,
                        observations: orderDetails.observations,
                        deliveryFee: orderDetails.deliveryFee,
                        pixPaymentId: data.paymentId, // Salva o ID do pagamento do Mercado Pago
                        pixQrCodeText: data.qrCodeText, // Salva o código copia e cola do PIX
                        pixExpirationTime: data.expirationTime, // Salva a expiração do PIX
                    };

                    const allOrdersCollectionRef = collection(db, 'artifacts', currentAppId, 'public', 'data', 'all_orders');
                    const newPublicOrderRef = await addDoc(allOrdersCollectionRef, orderData);
                    const orderIdForBoth = newPublicOrderRef.id;

                    const userOrderDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'orders', orderIdForBoth);
                    await setDoc(userOrderDocRef, { ...orderData, id: orderIdForBoth });

                    onClearCart(); // Limpa o carrinho após o pedido ser salvo
                    console.log("Pedido PIX gerado e salvo no Firestore com sucesso!");
                    // Não há navegação imediata para 'my-orders' aqui; o usuário precisa ver o QR code
                } else {
                    setPixError(data.error || 'Erro desconhecido ao gerar PIX.');
                    console.error("Erro ao gerar PIX:", data);
                }
            } catch (error) {
                setPixError('Erro de conexão ao gerar PIX. Verifique sua rede.');
                console.error("Erro de rede ao gerar PIX:", error);
            } finally {
                setPixLoading(false);
                setSubmittingPayment(false);
            }
        } else {
            // Lógica existente para pagamentos que não são PIX
            try {
                const orderData = {
                    userId: userId,
                    userEmail: userEmail || 'anonimo@example.com',
                    items: orderDetails.cartItems,
                    total: orderDetails.totalPrice,
                    status: 'Pendente', // Status inicial para outros métodos
                    timestamp: serverTimestamp(),
                    deliveryAddress: orderDetails.deliveryAddress,
                    whatsapp: orderDetails.whatsapp,
                    paymentMethod: orderDetails.paymentMethod,
                    observations: orderDetails.observations,
                    deliveryFee: orderDetails.deliveryFee,
                };

                const allOrdersCollectionRef = collection(db, 'artifacts', currentAppId, 'public', 'data', 'all_orders');
                const newPublicOrderRef = await addDoc(allOrdersCollectionRef, orderData);
                const orderIdForBoth = newPublicOrderRef.id;

                const userOrderDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'orders', orderIdForBoth);
                await setDoc(userOrderDocRef, { ...orderData, id: orderIdForBoth });

                onClearCart();
                console.log("Pagamento confirmado! Seu pedido foi realizado com sucesso.");
                onNavigate('my-orders'); // Redireciona para a página de meus pedidos
            } catch (error) {
                console.error("Erro ao finalizar pedido:", error);
            } finally {
                setSubmittingPayment(false);
            }
        }
    };

    // --- EFEITO PARA CONTADOR REGRESSIVO DO PIX ---
    useEffect(() => {
        if (pixData && pixData.expirationTime) {
            const expirationTimestamp = new Date(pixData.expirationTime).getTime();
            const updateCountdown = () => {
                const now = new Date().getTime();
                const timeLeft = Math.max(0, Math.floor((expirationTimestamp - now) / 1000));
                setCountdown(timeLeft);

                if (timeLeft <= 0) {
                    clearInterval(countdownIntervalRef.current);
                    console.log("Tempo para pagamento PIX expirou.");
                    // Opcional: setPixError("Tempo para pagamento Pix expirou. Por favor, faça um novo pedido.");
                }
            };

            // Limpa qualquer intervalo existente antes de iniciar um novo
            if (countdownIntervalRef.current) {
                clearInterval(countdownIntervalRef.current);
            }

            // Define o contador inicial e atualiza a cada segundo
            updateCountdown();
            countdownIntervalRef.current = setInterval(updateCountdown, 1000);
        }

        // Função de limpeza para parar o intervalo quando o componente for desmontado ou pixData mudar
        return () => {
            if (countdownIntervalRef.current) {
                clearInterval(countdownIntervalRef.current);
            }
        };
    }, [pixData]); // Depende de pixData para reiniciar quando um novo PIX é gerado

    // --- FUNÇÕES AUXILIARES ---
    // Formata o tempo para MM:SS
    const formatTime = (seconds) => {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    };

    // Copia o código PIX para a área de transferência
    const copyPixCode = () => {
        if (pixData && pixData.qrCodeText) {
            // Usando document.execCommand('copy') para melhor compatibilidade com iframes
            const el = document.createElement('textarea');
            el.value = pixData.qrCodeText;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            setShowCopyMessage(true);
            setTimeout(() => setShowCopyMessage(false), 2000); // Esconde a mensagem após 2 segundos
        }
    };


    return (
        <div className="p-4 sm:p-6 bg-teal-100 min-h-screen pb-32">
            <button
                onClick={() => onNavigate('order-finalization')}
                className="mb-4 sm:mb-6 flex items-center text-teal-600 hover:text-teal-800 font-semibold text-sm sm:text-base"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5 mr-1 sm:mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Voltar para Finalização
            </button>

            <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-xl p-6 sm:p-8 text-center">
                <h2 className="text-3xl sm:text-4xl font-extrabold text-gray-900 mb-8">Confirmação de Pagamento</h2>

                {orderDetails.paymentMethod === 'pix' ? (
                    <div className="mb-8">
                        {pixLoading ? (
                            <LoadingSpinner />
                        ) : pixError ? (
                            <div className="text-red-500 text-lg mb-4">{pixError}</div>
                        ) : pixData ? (
                            <>
                                <p className="text-xl font-semibold text-gray-700 mb-4">Pague com Pix:</p>
                                {/* Imagem do QR Code em base64 */}
                                <img
                                    src={`data:image/png;base64,${pixData.qrCodeBase64}`}
                                    alt="QR Code Pix"
                                    className="mx-auto my-4 rounded-lg shadow-md border-2 border-gray-200 w-48 h-48 sm:w-60 sm:h-60"
                                />
                                <p className="text-lg text-gray-600">Escaneie o QR Code acima ou use o código:</p>
                                <div className="relative bg-gray-100 p-3 rounded-lg mt-3 mb-4 border border-gray-300 break-all text-sm sm:text-base">
                                    <span className="font-mono">{pixData.qrCodeText}</span>
                                    <button
                                        onClick={copyPixCode}
                                        className="absolute top-1/2 right-3 -translate-y-1/2 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold py-1 px-2 rounded-md transition duration-200"
                                    >
                                        {showCopyMessage ? 'Copiado!' : 'Copiar'}
                                    </button>
                                </div>
                                {countdown > 0 && (
                                    <p className="text-red-500 font-semibold text-md mt-2">
                                        Tempo restante: {formatTime(countdown)}
                                    </p>
                                )}
                                {countdown <= 0 && pixData && (
                                    <p className="text-red-600 font-bold text-lg mt-2">
                                        O tempo para pagamento Pix expirou.
                                    </p>
                                )}
                            </>
                        ) : (
                            <p className="text-lg text-gray-600">Preparando seu Pix...</p>
                        )}
                    </div>
                ) : (
                    <div className="mb-8">
                        <p className="text-xl font-semibold text-gray-700 mb-4">Pagamento com {orderDetails.paymentMethod} (Simulado):</p>
                        <p className="text-lg text-gray-600">Por favor, prossiga com o pagamento de R$ {orderDetails.totalPrice.toFixed(2)} na maquininha ao receber o pedido.</p>
                        <p className="text-sm text-gray-500 mt-2">Esta é uma simulação. Nenhuma transação será processada.</p>
                    </div>
                )}

                <p className="text-2xl font-bold text-teal-800 mb-6">Total a Pagar: R$ {orderDetails.totalPrice.toFixed(2)}</p>

                {orderDetails.paymentMethod === 'pix' && !pixData && !pixError ? (
                    <button
                        onClick={handleProcessPayment} // Este botão agora dispara a geração do PIX
                        className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-8 rounded-full shadow-md transition duration-300 ease-in-out transform hover:scale-105 disabled:opacity-50"
                        disabled={submittingPayment || pixLoading}
                    >
                        {pixLoading ? 'Gerando Pix...' : 'Gerar Pix e Finalizar Pedido'}
                    </button>
                ) : orderDetails.paymentMethod === 'pix' && pixData ? (
                    <button
                        onClick={() => onNavigate('my-orders')} // Após o PIX ser exibido, o usuário pode ir para os pedidos
                        className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-8 rounded-full shadow-md transition duration-300 ease-in-out transform hover:scale-105"
                    >
                        Voltar para Meus Pedidos
                    </button>
                ) : (
                    <button
                        onClick={handleProcessPayment} // Para outros métodos, isso salva no Firestore e navega
                        className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-8 rounded-full shadow-md transition duration-300 ease-in-out transform hover:scale-105 disabled:opacity-50"
                        disabled={submittingPayment}
                    >
                        {submittingPayment ? 'Confirmando...' : 'Fiz o pagamento'}
                    </button>
                )}
            </div>
        </div>
    );
};


const MyOrdersPage = ({ onNavigateBack, onShowAuthScreen }) => {
    const { userId, userEmail, db, currentAppId, isAuthReady } = useAppContext(); // showMessage removido
    const [orders, setOrders] = useState([]);
    const [ordersLoading, setOrdersLoading] = useState(true);

    // Substitua este número pelo número real do WhatsApp da sua loja
    const STORE_WHATSAPP_NUMBER = "5581992764831"; 

    useEffect(() => {
        console.log("MyOrdersPage useEffect trigger - userId:", userId, "userEmail:", userEmail, "db:", !!db, "isAuthReady:", isAuthReady);

        // Este listener só deve ser configurado se o Firebase, um userId e o estado de autenticação estiverem prontos.
        if (db && userId && isAuthReady) {
            setOrdersLoading(true); // Redefine o estado de carregamento quando os parâmetros mudam
            console.log(`MyOrdersPage: Configurando onSnapshot para pedidos para userId: ${userId}`);
            const ordersColRef = collection(db, 'artifacts', currentAppId, 'users', userId, 'orders');
            const q = query(
                ordersColRef,
                orderBy('timestamp', 'desc')
            );

            const unsubscribe = onSnapshot(q, (snapshot) => {
                console.log("MyOrdersPage onSnapshot: Dados recebidos.");
                const fetchedOrders = snapshot.docs.map(doc => {
                    const data = doc.data();
                    return {
                        id: doc.id,
                        ...data,
                        timestamp: data.timestamp ? data.timestamp.toDate() : null
                    };
                });
                fetchedOrders.sort((a, b) => (b.timestamp?.getTime() || 0) - (a.timestamp?.getTime() || 0));
                setOrders(fetchedOrders);
                setOrdersLoading(false);
            }, (error) => {
                console.error("MyOrdersPage: Erro ao carregar pedidos:", error); // showMessage removido
                setOrdersLoading(false);
            });

            return () => {
                console.log("MyOrdersPage: Limpando listener de pedidos.");
                unsubscribe();
            };
        } else {
            // Se as condições não forem atendidas, limpe os pedidos e pare o carregamento.
            console.log("MyOrdersPage useEffect: Condições NÃO atendidas para buscar pedidos. userId:", userId, "db:", !!db, "isAuthReady:", isAuthReady);
            setOrders([]);
            setOrdersLoading(false);
        }
    }, [userId, db, currentAppId, isAuthReady]); // showMessage removido das dependências

    // Função para obter as classes de cor com base no status
    const getStatusColorClass = (status) => {
        switch (status) {
            case 'Pendente':
                return 'text-yellow-600'; 
            case 'Confirmado': 
                return 'text-blue-600'; 
            case 'Em Preparação':
                return 'text-blue-600'; 
            case 'Saiu para Entrega':
                return 'text-purple-600'; 
            case 'Entregue':
                return 'text-green-600'; 
            case 'Cancelado':
                return 'text-red-600'; 
            default:
                return 'text-gray-700'; 
        }
    };

    const handleWhatsAppClick = (order) => {
        const addressText = order.deliveryAddress ? 
            `${order.deliveryAddress.rua}, ${order.deliveryAddress.numero}, ${order.deliveryAddress.bairro}, CEP: ${order.deliveryAddress.cep}${order.deliveryAddress.pontoReferencia ? ` (Ref: ${order.deliveryAddress.pontoReferencia})` : ''}`
            : 'Endereço não informado';

        let message = `*Novo Pedido - Açaí App*\n\n`;
        message += `*ID do Pedido:* ${order.id}\n`;
        message += `*Email do Cliente:* ${order.userEmail || 'Não informado'}\n`;
        message += `*WhatsApp do Cliente:* ${order.whatsapp || 'Não informado'}\n`;
        message += `*Endereço de Entrega:* ${addressText}\n\n`;
        
        message += `*Itens do Pedido:*\n`;
        order.items.forEach(item => {
            message += `- ${item.name} (x${item.quantity}) - R$ ${(item.basePrice * item.quantity).toFixed(2)}\n`;
            if (item.selectedDefaultIngredients && item.selectedDefaultIngredients.length > 0) {
                message += `  (Inclui: ${item.selectedDefaultIngredients.join(', ')})\n`;
            }
            if (item.toppings && item.toppings.length > 0) {
                message += `  (Adicionais: ${item.toppings.map(t => t.name).join(', ')})\n`;
            }
        });

        if (order.observations) {
            message += `\n*Observações:* ${order.observations}\n`;
        }

        message += `\n*Total:* R$ ${order.total.toFixed(2)}\n`;
        message += `*Forma de Pagamento:* ${order.paymentMethod}\n`;
        message += `*Status:* ${order.status || 'Pendente'}\n`;

        const encodedMessage = encodeURIComponent(message);
        window.open(`https://wa.me/${STORE_WHATSAPP_NUMBER}?text=${encodedMessage}`, '_blank');
    };


    if (ordersLoading) {
        return <LoadingSpinner />;
    }

    return (
        <div className="p-4 sm:p-6 bg-teal-100 min-h-screen pb-32"> {/* Changed from pb-24 to pb-32 */}
            <button
                onClick={onNavigateBack}
                className="mb-4 sm:mb-6 flex items-center text-teal-600 hover:text-teal-800 font-semibold text-sm sm:text-base"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5 mr-1 sm:mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Voltar para Menu
            </button>
            <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl p-6 sm:p-8">
                <h2 className="text-3xl sm:text-4xl font-extrabold text-gray-900 text-center mb-8">Meus Pedidos</h2>
                {/* AQUI: A condição para exibir o prompt de login agora inclui 'isAuthReady' */}
                {!userEmail && isAuthReady ? ( 
                    <div className="text-center">
                        <p className="text-gray-700 text-lg sm:text-xl mb-4">
                            Para ver seus pedidos (antigos e novos), por favor, faça login ou cadastre-se.
                        </p>
                        <button
                            onClick={onShowAuthScreen} 
                            className="bg-teal-600 hover:bg-teal-700 text-white font-bold py-2 px-6 rounded-xl shadow-md transition duration-200 ease-in-out transform hover:scale-105 text-base sm:text-lg"
                        >
                            Fazer Login / Cadastrar
                        </button>
                    </div>
                ) : (
                    orders.length === 0 ? (
                        <p className="text-center text-gray-600 text-lg sm:text-xl">Você não fez nenhum pedido ainda.</p>
                    ) : (
                        <div className="space-y-6">
                            
{orders?.map(order => (
  <div key={order.id} className="border p-4 rounded-lg shadow">
    <p><strong>Pedido:</strong> {order.id}</p>
    <p><strong>Status:</strong> {order.status || 'Desconhecido'}</p>
    <p><strong>Total:</strong> R$ {(order.total || 0).toFixed(2)}</p>

    {Array.isArray(order.items) && (
      <ul className="ml-4 mt-2 list-disc">
        {order.items.map((item, idx) => (
          <li key={idx}>
            {item.name || 'Produto'} - R$ {(item.price || 0).toFixed(2)} x {item.quantity || 1}
          </li>
        ))}
      </ul>
    )}
  </div>
))}

                                <div key={order.id} className="border border-gray-200 rounded-lg p-4 sm:p-5 shadow-sm">
                                    <p className="font-bold text-lg text-teal-700 mb-2">Pedido ID: {order.id.substring(0, 8)}...</p>
                                    <p className="text-gray-700 text-sm mb-2">Data: {order.timestamp ? order.timestamp.toLocaleString() : 'N/A'}</p>
                                    <p className="text-gray-700 text-base mb-3">
                                        Status: <span className={`font-extrabold text-lg ${getStatusColorClass(order.status)}`}>{order.status || 'Pendente'}</span>
                                    </p>
                                    <h3 className="font-semibold text-base text-gray-800 mb-2">Itens:</h3>
                                    <ul className="list-disc list-inside text-sm text-gray-600 mb-3">
                                        {order.items.map((item, index) => (
                                            <li key={index}>{item.name} x {item.quantity} - R$ ${(item.basePrice * item.quantity).toFixed(2)}
                                                {item.selectedDefaultIngredients && item.selectedDefaultIngredients.length > 0 && ` (Inclui: ${item.selectedDefaultIngredients.join(', ')})`}
                                                {item.toppings && item.toppings.length > 0 && ` (Adicionais: ${item.toppings.map(t => t.name).join(', ')})`}
                                            </li>
                                        ))}
                                    </ul>
                                    {order.observations && order.observations.trim() !== '' && ( // Exibe observações se existirem
                                        <div className="bg-yellow-50 p-3 rounded-md mt-2">
                                            <p className="text-sm text-gray-700">
                                                <span className="font-semibold">Observação:</span> {order.observations}
                                            </p>
                                        </div>
                                    )}
                                    {order.deliveryAddress && ( // Exibe endereço se existir
                                        <div className="bg-blue-50 p-3 rounded-md mt-2">
                                            <p className="text-sm text-gray-700">
                                                <span className="font-semibold">Endereço de Entrega:</span> {order.deliveryAddress.rua}, {order.deliveryAddress.numero}, {order.deliveryAddress.bairro} - CEP: {order.deliveryAddress.cep}
                                                {order.deliveryAddress.pontoReferencia && ` (Ref: ${order.deliveryAddress.pontoReferencia})`}
                                            </p>
                                        </div>
                                    )}
                                    {order.whatsapp && ( // Exibe WhatsApp se existir
                                        <div className="bg-green-50 p-3 rounded-md mt-2">
                                            <p className="text-sm text-gray-700">
                                                <span className="font-semibold">WhatsApp do Cliente:</span> {order.whatsapp}
                                            </p>
                                        </div>
                                    )}
                                    <p className="font-extrabold text-xl text-teal-800 text-right mt-3">Total: R$ {order.total.toFixed(2)}</p>
                                    <p className="text-sm text-gray-700 text-right">Forma de Pagamento: {order.paymentMethod}</p> {/* Exibe forma de pagamento */}
                                    <div className="mt-4 flex justify-end">
                                        <button
                                            onClick={() => handleWhatsAppClick(order)}
                                            className="bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded-xl flex items-center space-x-2 shadow-md transition duration-200"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M.057 24l1.687-6.163c-1.041-1.804-1.557-3.842-1.557-5.88C.187 6.76 6.072 0 13.565 0c3.085 0 6.082 1.226 8.281 3.425C24.041 5.625 25.266 8.622 25.266 11.707c0 7.493-6.183 13.592-13.712 13.592-2.083 0-4.119-.505-5.918-1.54L.057 24zm6.597-3.807l-.422-.249c-1.01-1.748-1.521-3.754-1.521-5.772 0-6.198 5.06-11.267 11.306-11.267 3.011 0 5.864 1.173 8.04 3.359 2.179 2.188 3.359 5.047 3.359 8.051 0 6.205-5.068 11.275-11.314 11.275-1.966 0-3.957-.497-5.698-1.524l-.249-.147-2.606.878 1.011-2.484zm8.618-2.651c-.13-.075-.852-.416-.983-.464-.131-.048-.225-.072-.32-.072-.1 0-.175.036-.269.108-.094.072-.369.416-.454.509-.087.094-.175.108-.32.036-.832-.398-1.972-.899-2.809-1.725-.69-.676-1.155-1.517-1.442-1.962-.286-.445-.032-.693.204-.925.187-.189.416-.464.55-.653.13-.187.175-.32.269-.509.094-.187.048-.36-.024-.509-.072-.145-.646-.145-1.02-.145-.375 0-.852.048-1.306.492-.454.445-1.751 1.713-1.751 4.175 0 2.463 1.799 4.811 2.068 5.176.269.366 3.535 5.518 8.529 6.467 4.995.948 5.923.676 6.998.676.877 0 1.958-.337 2.336-1.378.374-1.042.374-1.933.269-2.122-.104-.187-.389-.292-.814-.485z" />
                                            </svg>
                                            Acompanhe no WhatsApp
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )
                )}
            </div>
        </div>
    );
};

const ProfilePage = ({ onNavigateBack }) => {
    const { userId, userEmail, db, currentAppId, handleLogout } = useAppContext(); // showMessage removido
    const [userProfile, setUserProfile] = useState(null);
    const [profileLoading, setProfileLoading] = useState(true);
    const [editMode, setEditMode] = useState(false);
    
    // Estados para os campos de perfil
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [cep, setCep] = useState('');
    const [rua, setRua] = useState('');
    const [numero, setNumero] = useState('');
    const [bairro, setBairro] = useState('');
    const [pontoReferencia, setPontoReferencia] = useState('');

    const [saveLoading, setSaveLoading] = useState(false);

    useEffect(() => {
        if (!userId || !db) {
            setProfileLoading(false);
            return;
        }

        const userProfileDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'profile', 'details');
        const unsubscribe = onSnapshot(userProfileDocRef, (docSnapshot) => {
            if (docSnapshot.exists()) {
                const data = docSnapshot.data();
                setUserProfile(data);
                setName(data.name || '');
                setPhone(data.phone || '');
                setCep(data.address?.cep || '');
                setRua(data.address?.street || '');
                setNumero(data.address?.number || '');
                setBairro(data.address?.neighborhood || '');
                setPontoReferencia(data.address?.reference || '');
            } else {
                setUserProfile(null);
                setName('');
                setPhone('');
                setCep('');
                setRua('');
                setNumero('');
                setBairro('');
                setPontoReferencia('');
            }
            setProfileLoading(false);
        }, (error) => {
            console.error("Erro ao carregar perfil:", error); // showMessage removido
            setProfileLoading(false);
        });

        return () => unsubscribe();
    }, [userId, db, currentAppId]); // showMessage removido das dependências

    const handleSaveProfile = async () => {
        setSaveLoading(true);
        try {
            const userProfileDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'profile', 'details');
            await setDoc(userProfileDocRef, {
                name: name || '', // Garante que é uma string
                email: userEmail, 
                phone: phone || '', // Garante que é uma string
                address: { // Garante que todos os campos de endereço são strings
                    cep: cep || '', 
                    street: rua || '', 
                    number: numero || '', 
                    neighborhood: bairro || '', 
                    reference: pontoReferencia || ''
                },
                lastUpdated: serverTimestamp() // Usa serverTimestamp para consistência
            }, { merge: true });
            console.log("Perfil atualizado com sucesso!"); // showMessage removido
            setEditMode(false);
        } catch (error) {
            console.error("Erro ao salvar perfil:", error); // showMessage removido
        } finally {
            setSaveLoading(false);
        }
    };

    if (profileLoading) {
        return <LoadingSpinner />;
    }

    if (!userEmail) {
        return (
            <div className="p-4 sm:p-6 bg-teal-100 min-h-screen flex flex-col items-center justify-center text-center">
                <p className="text-gray-700 text-lg sm:text-xl mb-4">Por favor, faça login para ver seu perfil.</p>
                <button
                    onClick={onNavigateBack}
                    className="mt-3 sm:mt-4 text-teal-600 hover:text-teal-800 font-semibold text-sm sm:text-base"
                >
                    Voltar para Menu
                </button>
            </div>
        );
    }

    return (
        <div className="p-4 sm:p-6 bg-teal-100 min-h-screen pb-32"> {/* Changed from pb-24 to pb-32 */}
            <button
                onClick={onNavigateBack}
                className="mb-4 sm:mb-6 flex items-center text-teal-600 hover:text-teal-800 font-semibold text-sm sm:text-base"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5 mr-1 sm:mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Voltar para Menu
            </button>
            <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-xl p-6 sm:p-8">
                <h2 className="text-3xl sm:text-4xl font-extrabold text-gray-900 text-center mb-8">Meu Perfil</h2>
                {editMode ? (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-gray-700 text-sm font-semibold mb-1">Nome:</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500" 
                                placeholder="Seu nome completo"
                            />
                        </div>
                        <div>
                            <label className="block text-gray-700 text-sm font-semibold mb-1">Email:</label>
                            <input
                                type="email"
                                value={userEmail}
                                disabled
                                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-100 cursor-not-allowed"
                            />
                        </div>
                        <div>
                            <label className="block text-gray-700 text-sm font-semibold mb-1">Telefone (WhatsApp):</label>
                            <input
                                type="tel"
                                value={phone}
                                onChange={(e) => setPhone(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                                placeholder="(XX) XXXXX-XXXX"
                            />
                        </div>
                        {/* Campos de Endereço em modo de edição */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-gray-700 text-sm font-semibold mb-1">CEP:</label>
                                <input
                                    type="text"
                                    value={cep}
                                    onChange={(e) => setCep(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500" 
                                    placeholder="Ex: 51021-000"
                                />
                            </div>
                            <div>
                                <label className="block text-gray-700 text-sm font-semibold mb-1">Rua:</label>
                                <input
                                    type="text"
                                    value={rua}
                                    onChange={(e) => setRua(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500" 
                                    placeholder="Digite a rua"
                                />
                            </div>
                            <div>
                                <label className="block text-gray-700 text-sm font-semibold mb-1">Número:</label>
                                <input
                                    type="text"
                                    value={numero}
                                    onChange={(e) => setNumero(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500" 
                                    placeholder="Ex: 1234"
                                />
                            </div>
                            <div>
                                <label className="block text-gray-700 text-sm font-semibold mb-1">Bairro:</label>
                                <input
                                    type="text"
                                    value={bairro}
                                    onChange={(e) => setBairro(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500" 
                                    placeholder="Digite o bairro"
                                />
                            </div>
                            <div className="col-span-1 sm:col-span-2">
                                <label className="block text-gray-700 text-sm font-semibold mb-1">Ponto de Referência (Opcional):</label>
                                <input
                                    type="text"
                                    value={pontoReferencia}
                                    onChange={(e) => setPontoReferencia(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500" 
                                    placeholder="Ex: Ao lado do prédio azul"
                                />
                            </div>
                        </div>
                        <div className="flex justify-end space-x-3 mt-4">
                            <button
                                onClick={() => setEditMode(false)}
                                className="bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold py-2 px-5 rounded-md transition duration-200"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleSaveProfile}
                                className="bg-green-500 hover:bg-green-600 text-white font-semibold py-2 px-5 rounded-md transition duration-200 disabled:opacity-50"
                                disabled={saveLoading}
                            >
                                {saveLoading ? 'Salvando...' : 'Salvar'}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4 text-gray-800">
                        <p className="text-lg"><span className="font-semibold">Nome:</span> {name || 'Não informado'}</p>
                        <p className="text-lg"><span className="font-semibold">Email:</span> {userEmail}</p>
                        <p className="text-lg"><span className="font-semibold">Telefone (WhatsApp):</span> {phone || 'Não informado'}</p>
                        <div className="mb-4">
                            <h3 className="text-xl font-semibold mb-2">Endereço:</h3>
                            {cep || rua || numero || bairro || pontoReferencia ? (
                                <>
                                    <p className="text-lg">
                                        {rua}, {numero} - {bairro}
                                    </p>
                                    <p className="text-lg">
                                        CEP: {cep}
                                    </p>
                                    {pontoReferencia && <p className="text-lg">Ref: {pontoReferencia}</p>}
                                </>
                            ) : (
                                <p className="text-lg">Não informado</p>
                            )}
                        </div>
                        <div className="flex justify-between items-center mt-4"> {/* Adicionado flexbox para alinhar botões */}
                            <button
                                onClick={() => setEditMode(true)}
                                className="bg-teal-600 hover:bg-teal-700 text-white font-semibold py-2 px-5 rounded-md transition duration-200"
                            >
                                Editar Perfil
                            </button>
                            <button
                                onClick={handleLogout} // Adicionado botão de Sair
                                className="bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-5 rounded-md transition duration-200"
                            >
                                Sair
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// NOVO COMPONENTE: TopBar
const TopBar = () => {
    return (
        <div className="bg-purple-700 text-white p-4 text-center shadow-md"> {/* Removido 'fixed', 'top-0', 'left-0', 'right-0', 'z-50' */}
            <h1 className="text-2xl font-bold">appaçaí</h1>
        </div>
    );
};


const App = () => {
    const { db, auth, userId, userEmail, loadingFirebase, currentAppId, message, messageType, handleCloseMessage, isAuthReady, handleLogout } = useAppContext(); // showMessage removido

    const [cart, setCart] = useState([]);
    const [currentPage, setCurrentPage] = useState('home');
    const [selectedProduct, setSelectedProduct] = useState(null);
    const [showAuthScreen, setShowAuthScreen] = useState(false); 
    const [orderDetailsForCheckout, setOrderDetailsForCheckout] = useState(null); // Estado para passar detalhes do pedido
    const [authCallbackPage, setAuthCallbackPage] = useState('home'); // NOVO: Página para redirecionar após autenticação

    const handleClearCart = useCallback(async () => {
        if (!userId || !db || !currentAppId) {
            console.warn("Não foi possível limpar o carrinho: userId, db ou currentAppId não disponíveis.");
            return;
        }
        setCart([]);
        try {
            const userCartDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'cart', 'currentCart');
            await deleteDoc(userCartDocRef);
            console.log("Carrinho do Firestore limpo com sucesso.");
        } catch (e) {
            console.error("Erro ao limpar carrinho no Firestore: ", e);
        }
    }, [userId, db, currentAppId]);

    const handleAddToCart = useCallback(async (productToAdd) => {
        console.log("DEBUG: handleAddToCart chamado. userId antes da verificação:", userId); // NEW LOG
        if (!userId) {
            console.error("Erro: ID de usuário não disponível. Tente novamente."); // showMessage removido
            return;
        }
        if (!db || !currentAppId) {
            console.error("Erro: Serviço de banco de dados não disponível."); // showMessage removido
            return;
        }

        const effectiveCartItemId = productToAdd.cartItemId || `${productToAdd.id}-default`;

        const existingItemIndex = cart.findIndex(item => item.cartItemId === effectiveCartItemId);
        let updatedCart = [];

        if (existingItemIndex > -1) {
            updatedCart = cart.map((item, index) =>
                index === existingItemIndex ? { ...item, quantity: item.quantity + productToAdd.quantity } : item
            );
        } else {
            updatedCart = [...cart, { ...productToAdd, cartItemId: effectiveCartItemId }];
        }

        setCart(updatedCart);

        try {
            const userCartDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'cart', 'currentCart');
            console.log("DEBUG: Caminho do Firestore para adicionar/atualizar carrinho:", userCartDocRef.path); // NEW LOG
            console.log("DEBUG: Dados do carrinho a serem salvos:", updatedCart); // NEW LOG
            await setDoc(userCartDocRef, { items: updatedCart }, { merge: true });
            console.log("Item adicionado ao carrinho!"); // showMessage removido
            console.log("DEBUG: Item adicionado/atualizado no Firestore com sucesso."); // NEW LOG
        } catch (e) {
            console.error("DEBUG: Erro ao adicionar item ao carrinho no Firestore: ", e); // MODIFIED LOG
            // showMessage("Erro ao adicionar item ao carrinho no servidor.", "error"); // Removido
        }
    }, [userId, db, currentAppId, cart]); // showMessage removido das dependências

    const handleUpdateCartItem = useCallback(async (updatedItem) => {
        console.log("DEBUG: handleUpdateCartItem chamado. userId antes da verificação:", userId); // NEW LOG
        if (!userId) {
            console.error("Erro: ID de usuário não disponível. Tente novamente."); // showMessage removido
            return;
        }
        if (!db || !currentAppId) {
            console.error("Erro: Serviço de banco de dados não disponível."); // showMessage removido
            return;
        }

        const updatedCart = cart.map(item =>
            item.cartItemId === updatedItem.cartItemId ? updatedItem : item
        );
        setCart(updatedCart);

        try {
            const userCartDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'cart', 'currentCart');
            console.log("DEBUG: Caminho do Firestore para atualizar carrinho:", userCartDocRef.path); // NEW LOG
            console.log("DEBUG: Dados do carrinho a serem atualizados:", updatedCart); // NEW LOG
            await setDoc(userCartDocRef, { items: updatedCart }, { merge: true });
            console.log("DEBUG: Item do carrinho atualizado no Firestore com sucesso."); // NEW LOG
        } catch (e) {
            console.error("DEBUG: Erro ao atualizar item do carrinho no Firestore: ", e); // MODIFIED LOG
            // showMessage("Erro ao atualizar item no carrinho no servidor.", "error"); // Removido
        }
    }, [userId, db, currentAppId, cart]); // showMessage removido das dependências

    const handleRemoveFromCart = useCallback(async (cartItemId) => {
        if (!userId) {
            console.error("Erro: ID de usuário não disponível. Tente novamente."); // showMessage removido
            return;
        }
        if (!db || !currentAppId) {
            console.error("Erro: Serviço de banco de dados não disponível."); // showMessage removido
            return;
        }

        const updatedCart = cart.filter(item => item.cartItemId !== cartItemId);
        setCart(updatedCart);

        try {
            const userCartDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'cart', 'currentCart');
            await setDoc(userCartDocRef, { items: updatedCart }, { merge: true });
            console.log("Item removido do carrinho!"); // showMessage removido
        } catch (e) {
            console.error("Erro ao remover item do carrinho no Firestore: ", e);
            // showMessage("Erro ao remover item do carrinho no servidor.", "error"); // Removido
        }
    }, [userId, db, currentAppId, cart]); // showMessage removido das dependências

    useEffect(() => {
        console.log("App (Cart useEffect) - Current state:", { loadingFirebase, db: !!db, userId, isAuthReady, currentAppId });
        if (!loadingFirebase && db && userId && isAuthReady) {
            console.log("App (Cart useEffect) - Condições satisfeitas. Configurando listener do carrinho para userId:", userId, "appId:", currentAppId);
            const userCartDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'cart', 'currentCart');
            const unsubscribeCart = onSnapshot(userCartDocRef, (docSnapshot) => {
                console.log("App (Cart Snapshot) - Dados do carrinho recebidos. Documento existe:", docSnapshot.exists());
                if (docSnapshot.exists()) {
                    setCart(docSnapshot.data().items || []);
                    console.log("DEBUG: Itens do carrinho do Firestore:", docSnapshot.data().items || []); // DEBUG LOG
                } else {
                    setCart([]);
                    console.log("DEBUG: Documento do carrinho não existe ou foi excluído."); // DEBUG LOG
                }
            }, (error) => {
                console.error("DEBUG: Erro no onSnapshot do carrinho:", error); // DEBUG LOG
                // Modificado: Se for um erro de permissão, apenas avisa no console, não mostra notificação ao usuário
                if (error.code === 'permission-denied' || error.code === 'unavailable') {
                    console.warn("AVISO: Permissão negada ou serviço indisponível ao carregar carrinho. Isso pode ser temporário durante a inicialização/autenticação.");
                } else {
                    // showMessage("Erro ao carregar seu carrinho. Tente novamente mais tarde.", "error"); // Removido
                }
            });

            return () => {
                console.log("App (Cart useEffect) - Limpando listener do carrinho para userId:", userId);
                unsubscribeCart();
            };
        } else {
            console.log("App (Cart useEffect) - Condições NÃO satisfeitas. Pulando configuração do listener do carrinho ou userId é nulo.");
            if (cart.length > 0) {
                setCart([]);
            }
        }
    }, [loadingFirebase, db, userId, currentAppId, isAuthReady]); // showMessage removido das dependências

    // NOVO useEffect para sincronizar orderDetailsForCheckout com o carrinho atualizado
    useEffect(() => {
        // Este efeito é executado sempre que o estado 'cart' muda.
        // Queremos atualizar orderDetailsForCheckout apenas se estivermos nas páginas de finalização ou checkout
        // E o carrinho tiver itens (o que significa que foi carregado/migrado).
        console.log("DEBUG: useEffect de orderDetailsForCheckout acionado. Current Cart:", cart, "Current Page:", currentPage); // DEBUG LOG
        if (cart.length > 0 && (currentPage === 'order-finalization' || currentPage === 'checkout-payment')) {
            // Recalcula o total com base no carrinho atualizado
            const newTotalPrice = cart.reduce((total, item) => total + (item.basePrice * item.quantity), 0);

            // Preserva as informações de endereço/pagamento existentes, mas atualiza os itens do carrinho e o total
            setOrderDetailsForCheckout(prevDetails => {
                // Se prevDetails for nulo (primeira vez que está sendo definido após a navegação),
                // precisamos garantir a estrutura básica.
                const currentObservations = prevDetails?.observations || '';
                const currentDeliveryFee = prevDetails?.deliveryFee || 0;
                const currentDeliveryAddress = prevDetails?.deliveryAddress || {};
                const currentWhatsapp = prevDetails?.whatsapp || '';
                const currentPaymentMethod = prevDetails?.paymentMethod || 'pix';

                const updatedDetails = {
                    cartItems: cart, // Always use the latest 'cart' state for items
                    totalPrice: newTotalPrice, // Always re-calculate total based on latest 'cart'
                    observations: currentObservations,
                    deliveryFee: currentDeliveryFee,
                    deliveryAddress: currentDeliveryAddress,
                    whatsapp: currentWhatsapp,
                    paymentMethod: currentPaymentMethod,
                };
                console.log("DEBUG: orderDetailsForCheckout atualizado para:", updatedDetails); // DEBUG LOG
                return updatedDetails;
            });
        } else if (cart.length === 0 && (currentPage === 'order-finalization' || currentPage === 'checkout-payment')) {
            console.log("DEBUG: Carrinho vazio na página de finalização/checkout. Limpando orderDetailsForCheckout."); // DEBUG LOG
            setOrderDetailsForCheckout(null);
        }
    }, [cart, currentPage, setOrderDetailsForCheckout]);


    const totalCartItems = cart.reduce((total, item) => total + item.quantity, 0);
    const totalCartPrice = cart.reduce((total, item) => total + (item.basePrice * item.quantity), 0);

    if (loadingFirebase || !isAuthReady) {
        return <LoadingSpinner />;
    }

    const renderPage = () => {
        switch (currentPage) {
            case 'home':
                return <ProductList onSelectProduct={(product) => { setSelectedProduct(product); setCurrentPage('product-details'); }} />;
            case 'product-details':
                return <ProductDetailPage product={selectedProduct} onAddToCart={handleAddToCart} onNavigateBack={() => setCurrentPage('home')} />;
            case 'cart':
                return <CartPage
                    cart={cart}
                    onUpdateCartItem={handleUpdateCartItem}
                    onRemoveFromCart={handleRemoveFromCart}
                    onClearCart={handleClearCart}
                    onNavigateToFinalization={(details) => { // orderDetails vem do CartPage
                        setOrderDetailsForCheckout(details);
                        // Se não estiver logado, mostra tela de autenticação
                        if (!userEmail) {
                            setAuthCallbackPage('order-finalization'); // Define a página de retorno para 'order-finalization'
                            setShowAuthScreen(true);
                        } else {
                            // Se já estiver logado, vai direto para a página de finalização
                            setCurrentPage('order-finalization');
                        }
                    }}
                    onNavigateBack={() => setCurrentPage('home')}
                    onAddToCart={handleAddToCart} 
                />;
            case 'order-finalization':
                return <OrderFinalization
                    cart={cart}
                    onNavigate={setCurrentPage}
                    onShowAuthScreen={() => {
                        setAuthCallbackPage('order-finalization'); // Define a página de retorno para 'order-finalization'
                        setShowAuthScreen(true);
                    }}
                    setOrderDetailsForCheckout={setOrderDetailsForCheckout} // Passa a função para OrderFinalization
                    orderDetails={orderDetailsForCheckout} // Passa os detalhes do carrinho para Finalização
                />;
            case 'checkout-payment':
                return <CheckoutPage
                    orderDetails={orderDetailsForCheckout} // Passa os detalhes do pedido
                    onNavigate={setCurrentPage}
                    onClearCart={handleClearCart}
                />;
            case 'my-orders':
                return <MyOrdersPage onNavigateBack={() => setCurrentPage('home')} onShowAuthScreen={() => {
                    setAuthCallbackPage('home'); // Define a página de retorno para 'home'
                    setShowAuthScreen(true);
                }} />; 
            case 'profile':
                return <ProfilePage onNavigateBack={() => setCurrentPage('home')} />;
            default:
                return <ProductList onSelectProduct={(product) => { setSelectedProduct(product); setCurrentPage('product-details'); }} />;
        }
    };

    return (
        <div className="font-inter bg-gradient-to-br from-teal-800 to-green-900">
            <TopBar /> {/* Adicionado o componente TopBar de volta */}
            {/* Removido o padding-top que compensava a barra fixa */}
            <Navbar
                currentPage={currentPage}
                onNavigate={setCurrentPage}
                onLogout={handleLogout} 
                userEmail={userEmail}
            />
            {/* FloatingCartButton movido para o topo */}
            <FloatingCartButton
                totalItems={totalCartItems}
                totalPrice={totalCartPrice}
                onNavigateToCart={() => setCurrentPage('cart')}
                currentPage={currentPage}
            />

            {renderPage()}
            

            {showAuthScreen && ( 
                <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-40 p-4">
                    <AuthScreen 
                        onLoginSuccess={() => {
                            setShowAuthScreen(false);
                            setCurrentPage(authCallbackPage); // Usa a página de retorno definida
                        }} 
                        onClose={() => setShowAuthScreen(false)} 
                    />
                </div>
            )}

            {/* A MessageBox não será mais ativada por showMessage, mas o componente permanece caso você queira usá-lo manualmente */}
            <MessageBox message={message} type={messageType} onClose={handleCloseMessage} />
        </div>
    );
};

const RootApp = () => (
    <AppProvider>
        <App />
    </AppProvider>
);

export default RootApp;
