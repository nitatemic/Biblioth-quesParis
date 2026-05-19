// ==UserScript==
// @name         Paris Bibliothèques - Optimiseur de Panier
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Récupère les disponibilités du panier et optimise le parcours de ramassage (Algo Glouton).
// @author       Vous
// @match        https://bibliotheques.paris.fr/\*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 1. Bouton pour lancer l'optimisation
    function injectUI() {
        const btn = document.createElement('button');
        btn.innerText = 'Optimiser le ramassage';
        btn.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; padding: 15px; background: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; box-shadow: 0 4px 6px rgba(0,0,0,0.3);';
        
        btn.addEventListener('click', runOptimization);
        document.body.appendChild(btn);
    }

    // 2. Extraire les articles du panier
    function getPanierItems() {
        const items = [];
        
        // 1. Chercher dans les liens (format Syracuse habituel : /doc/SYRACUSE/1363247/...)
        const links = document.querySelectorAll('a[href*="SYRACUSE"]');
        links.forEach(link => {
            const urlMatch = link.href.match(/SYRACUSE\/(\d+)/i);
            if (urlMatch) {
                items.push({
                    title: link.innerText.trim() || `Livre (${urlMatch[1]})`,
                    rscId: urlMatch[1],
                    docbase: "SYRACUSE"
                });
            }
        });

        // 2. Chercher les RscId dans n'importe quel attribut href ou onclick
        const allElements = document.querySelectorAll('a, button, [onclick]');
        allElements.forEach(el => {
            const html = el.outerHTML;
            const rscIdMatch = html.match(/RscId['"]?:\s*['"]?(\d+)/i) || 
                               html.match(/RscId=(\d+)/i) ||
                               html.match(/id:\s*['"]?(\d+)['"]?,\s*docbase/i); // Syracuse onClick events
            if (rscIdMatch) {
                // On essaie de trouver un titre proche
                let title = el.innerText.trim();
                if (!title || title.length < 3) title = `Document (${rscIdMatch[1]})`;
                items.push({
                    title: title,
                    rscId: rscIdMatch[1],
                    docbase: "SYRACUSE"
                });
            }
        });

        // Filtrer les IDs invalides et dé-dupliquer
        const validItems = items.filter(item => item.rscId && !isNaN(item.rscId));
        return Array.from(new Map(validItems.map(item => [item.rscId, item])).values());
    }

    // 3. Appel de l'API pour un RscId donné avec gestion du timeout et des retries
    async function fetchHoldings(rscId, docbase, retries = 2) {
        for (let i = 0; i <= retries; i++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 secondes de timeout max par requête

                const response = await fetch("https://bibliotheques.paris.fr/Portal/Services/ILSClient.svc/GetHoldings", {
                    "headers": {
                        "accept": "application/json, text/plain, */*",
                        "content-type": "application/json",
                    },
                    "body": JSON.stringify({
                        "Record": { "RscId": rscId, "Docbase": docbase },
                        "searchQuery": {
                            "LabelFilter": [], "Page": 0, "ResultSize": 25, "SearchInput": "",
                            "TemplateParams": { "Scenario": "", "Scope": "Default", "Size": null, "Source": "", "Support": "", "UseCompact": false },
                            "ScenarioCode": "DEFAULT"
                        }
                    }),
                    "method": "POST",
                    "mode": "cors",
                    "credentials": "include",
                    "signal": controller.signal
                });
                
                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`Erreur HTTP: ${response.status}`);
                }

                const data = await response.json();
                return data;
            } catch (error) {
                console.warn(`Erreur pour l'ID ${rscId} (Essai ${i + 1}/${retries + 1}):`, error);
                if (i === retries) return null; // On abandonne après N essais
                // Attendre 1.5 secondes avant de réessayer
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }
    }

    // 4. Analyser la réponse et la normaliser
    function extractAvailability(apiResponse) {
        const availableBranches = [];
        
        const holdings = apiResponse?.d?.Holdings || apiResponse?.Holdings || [];
        
        holdings.forEach(holding => {
            // La disponibilité est confirmée par le booléen IsAvailable ou le mot clé "rayon"
            const isAvailable = holding.IsAvailable === true || (holding.Statut && holding.Statut.toLowerCase().includes('rayon'));
            
            if (isAvailable && holding.Site) {
                // Le nom de la bibliothèque se trouve dans holding.Site
                availableBranches.push(holding.Site.trim());
            }
        });
        
        // On dé-duplique au cas où un livre soit présent plusieurs fois dans la même bibliothèque
        return [...new Set(availableBranches)];
    }

    // 5. Algorithme Glouton (Greedy)
    function calculateOptimizedRoute(itemsMap) {
        // itemsMap: { "Titre livre": ["Biblio A", "Biblio B"], ... }
        
        // Liste de tous les livres à trouver
        let remainingBooks = new Set(Object.keys(itemsMap));
        
        // Mapping Inversé: Biblio -> Set([livres disponibles])
        const biblioToBooks = {};
        for (const [book, biblios] of Object.entries(itemsMap)) {
            for (const biblio of biblios) {
                if (!biblioToBooks[biblio]) {
                    biblioToBooks[biblio] = new Set();
                }
                biblioToBooks[biblio].add(book);
            }
        }

        const route = []; // Liste des étapes : { biblio: ..., books: [...] }

        while (remainingBooks.size > 0) {
            let bestBiblio = null;
            let bestCoverage = new Set();

            for (const [biblio, availabilitySet] of Object.entries(biblioToBooks)) {
                // Combient de livres manquants cette bibliothèque couvre-t-elle ?
                const coverage = new Set([...availabilitySet].filter(x => remainingBooks.has(x)));
                
                if (coverage.size > bestCoverage.size) {
                    bestCoverage = coverage;
                    bestBiblio = biblio;
                }
            }

            // Si aucune bibliothèque ne peut fournir les livres restants
            if (bestCoverage.size === 0) {
                const missing = Array.from(remainingBooks);
                route.push({ biblio: "INDISPONIBLE / INTROUVABLE", books: missing });
                break;
            }

            // On ajoute cette étape au trajet
            route.push({ biblio: bestBiblio, books: Array.from(bestCoverage) });

            // On retire ces livres des livres restants
            bestCoverage.forEach(book => remainingBooks.delete(book));
        }

        return route;
    }

    // 6. Afficher l'interface de résultat
    function showReport(route) {
        const modal = document.createElement('div');
        modal.style.cssText = 'position: fixed; top: 10%; left: 10%; width: 80%; height: 80%; background: white; border: 2px solid #ccc; z-index: 10000; padding: 20px; overflow-y: auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-radius: 10px; color: black;';
        
        let html = '<h2>Optimisation du Ramassage</h2><ul>';
        
        route.forEach(step => {
            html += `<li style="margin-bottom: 20px;">
                <strong>${step.biblio} (${step.books.length} document${step.books.length > 1 ? 's' : ''}) :</strong>
                <ul>${step.books.map(b => `<li>${b}</li>`).join('')}</ul>
            </li>`;
        });
        
        html += '</ul><button id="closeModalBtn" style="padding: 10px; background: red; color: white; border: none; border-radius: 5px; cursor: pointer;">Fermer</button>';
        modal.innerHTML = html;
        
        document.body.appendChild(modal);
        document.getElementById('closeModalBtn').addEventListener('click', () => modal.remove());
    }

    // Workflow Principal
    async function runOptimization() {
        const originalBtnText = this.innerText;
        this.innerText = "Chargement en cours...";
        this.disabled = true;

        const items = getPanierItems();
        if (items.length === 0) {
            alert("Aucun ID de livre (RscId) trouvé sur la page.\nVeuillez inspecter la page pour ajuster le sélecteur dans le script.");
            this.innerText = originalBtnText;
            this.disabled = false;
            return;
        }

        const itemsMap = {}; // "Titre": ["Biblio 1", "Biblio 2"]
        let count = 0;
        
        for (const item of items) {
            count++;
            this.innerText = `Recherche (${count}/${items.length})...`;

            const apiRes = await fetchHoldings(item.rscId, item.docbase);
            const availableBranches = extractAvailability(apiRes);
            if (availableBranches.length > 0) {
                itemsMap[item.title] = availableBranches;
            } else {
                itemsMap[item.title] = []; // Indisponible
            }

            // [ANTI RATE-LIMIT]
            // Pause de 750 millisecondes entre chaque appel pour ne pas surcharger le serveur
            await new Promise(resolve => setTimeout(resolve, 750));
        }

        const route = calculateOptimizedRoute(itemsMap);
        showReport(route);
        
        this.innerText = originalBtnText;
        this.disabled = false;
    }

    // Lancer quand la page est chargée
    window.addEventListener('load', injectUI);
})();
