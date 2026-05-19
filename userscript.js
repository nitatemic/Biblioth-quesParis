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

    // 4. Analyser la réponse et la normaliser avec sa cote
    function extractAvailability(apiResponse) {
        const availableBranches = [];
        
        const holdings = apiResponse?.d?.Holdings || apiResponse?.Holdings || [];
        
        holdings.forEach(holding => {
            // La disponibilité est confirmée par le booléen IsAvailable ou le mot clé "rayon"
            const isAvailable = holding.IsAvailable === true || (holding.Statut && holding.Statut.toLowerCase().includes('rayon'));
            
            if (isAvailable && holding.Site) {
                availableBranches.push({
                    biblio: holding.Site.trim(),
                    cote: holding.Cote ? holding.Cote.trim() : "Cote inconnue"
                });
            }
        });
        
        // On dé-duplique au cas où un livre soit présent plusieurs fois dans la même bibliothèque
        const uniqueBranches = [];
        const seen = new Set();
        for (const branch of availableBranches) {
            if (!seen.has(branch.biblio)) {
                seen.add(branch.biblio);
                uniqueBranches.push(branch);
            }
        }
        return uniqueBranches;
    }

    // 5. Algorithme Glouton (Greedy)
    function calculateOptimizedRoute(itemsMap) {
        let remainingBooks = new Set(Object.keys(itemsMap));
        
        // Mapping Inversé: Biblio -> { Titre: Cote }
        const biblioToBooks = {};
        for (const [book, branches] of Object.entries(itemsMap)) {
            for (const branch of branches) {
                if (!biblioToBooks[branch.biblio]) {
                    biblioToBooks[branch.biblio] = {};
                }
                biblioToBooks[branch.biblio][book] = branch.cote;
            }
        }

        const route = [];

        while (remainingBooks.size > 0) {
            let bestBiblio = null;
            let bestCoverage = [];

            for (const [biblio, booksObj] of Object.entries(biblioToBooks)) {
                const coverage = Object.keys(booksObj).filter(x => remainingBooks.has(x));
                
                if (coverage.length > bestCoverage.length) {
                    bestCoverage = coverage;
                    bestBiblio = biblio;
                }
            }

            if (bestCoverage.length === 0) {
                const missing = Array.from(remainingBooks).map(title => ({ title, cote: "N/A" }));
                route.push({ biblio: "INDISPONIBLE / INTROUVABLE", books: missing });
                break;
            }

            const booksWithCotes = bestCoverage.map(title => ({
                title: title,
                cote: biblioToBooks[bestBiblio][title]
            }));

            route.push({ biblio: bestBiblio, books: booksWithCotes });
            bestCoverage.forEach(book => remainingBooks.delete(book));
        }

        return route;
    }

    // 6. Afficher l'interface de résultat
    function showReport(route) {
        const modal = document.createElement('div');
        modal.style.cssText = 'position: fixed; top: 5%; left: 5%; width: 90%; max-width: 800px; height: 90%; max-height: 90vh; background: #f9f9f9; border: 1px solid #ddd; z-index: 10000; padding: 30px; overflow-y: auto; box-shadow: 0 15px 40px rgba(0,0,0,0.6); border-radius: 12px; color: #333; font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;';
        
        let html = '<h2 style="margin-top: 0; color: #2c3e50; border-bottom: 2px solid #e2e8f0; padding-bottom: 15px;">🏁 Votre parcours de ramassage optimisé</h2><ul style="list-style-type: none; padding: 0;">';
        
        route.forEach(step => {
            html += `<li style="margin-bottom: 25px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
                <h3 style="margin-top: 0; margin-bottom: 15px; color: #3498db; font-size: 1.3em;">
                    🏛️ ${step.biblio} <span style="background: #e1f0fa; color: #2980b9; font-size: 0.75em; padding: 3px 8px; border-radius: 12px; margin-left: 10px;">${step.books.length} document${step.books.length > 1 ? 's' : ''}</span>
                </h3>
                <ul style="margin: 0; padding-left: 15px; list-style-type: square; color: #555;">
                    ${step.books.map(b => `<li style="margin-bottom: 12px; line-height: 1.4;">
                        <strong style="color: #2c3e50; font-size: 1.1em;">${b.title}</strong><br>
                        <span style="display: inline-block; margin-top: 4px; color: #7f8c8d; font-size: 0.9em; background: #f8f9fa; padding: 4px 8px; border-radius: 4px; border: 1px solid #eaeaea; font-family: monospace;">📍 Cote : <b>${b.cote}</b></span>
                    </li>`).join('')}
                </ul>
            </li>`;
        });
        
        html += '</ul><div style="text-align: center; margin-top: 30px;"><button id="closeModalBtn" style="padding: 12px 30px; background: #e74c3c; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: 600; box-shadow: 0 4px 6px rgba(231, 76, 60, 0.3);">Fermer le rapport</button></div>';
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

        const itemsMap = {}; 
        let count = 0;
        
        for (const item of items) {
            count++;
            this.innerText = `Recherche (${count}/${items.length})...`;

            const apiRes = await fetchHoldings(item.rscId, item.docbase);
            
            // On extrait le vrai titre propre depuis l'API pour écraser "Livre (XXX)"
            let realTitle = item.title;
            if (apiRes?.d?.fieldList?.Title?.[0]) {
                realTitle = apiRes.d.fieldList.Title[0];
            }

            const availableBranches = extractAvailability(apiRes);
            if (availableBranches.length > 0) {
                itemsMap[realTitle] = availableBranches;
            } else {
                itemsMap[realTitle] = []; // Indisponible
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
