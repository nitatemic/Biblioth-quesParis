// ==UserScript==
// @name         Paris Bibliothèques - Optimiseur de Panier
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Récupère les disponibilités du panier et optimise le parcours de ramassage (Algo Glouton).
// @author       Vous
// @match        https://bibliotheques.paris.fr/*
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
        const libraryAddresses = {
            "Georges Brassens": "38, rue Gassendi",
            "Aimé Césaire": "5, rue de Ridder",
            "Benoîte Groult": "25, rue du commandant René Mouchotte",
            "Andrée Chedid": "36-40, rue Emeriau",
            "Gutenberg": "8, rue de la Montagne d’Aulas",
            "Vaugirard": "154, rue Lecourbe",
            "Marguerite Yourcenar": "41, rue d’Alleray",
            "Maison de Balzac": "47, rue Raynouard",
            "Germaine Tillion": "6, rue du Commandant Schloesing",
            "Tourisme et des voyages": "6, rue du Commandant Schloesing",
            "Musset": "20, rue de Musset",
            "Batignolles": "Mairie, 18 rue des Batignolles",
            "Colette Vivier": "6, rue Fourneyron",
            "Edmond Rostand": "11, rue Nicolas Chuquet",
            "Robert Sabatier": "29, rue Hermel",
            "Goutte d’Or": "2-4, rue Fleury",
            "Maurice Genevoix": "19, rue Tristan Tzara",
            "Jacqueline de Romilly": "16, avenue de la Porte-Montmartre",
            "Václav Havel": "26, esplanade Nathalie Sarraute",
            "Benjamin Rabier": "141, avenue de Flandre",
            "Claude Lévi-Strauss": "41, avenue de Flandre",
            "Astrid Lindgren": "42-44, rue Petit",
            "Archives de Paris": "18, boulevard Sérurier",
            "Jacqueline Dreyfus-Weill": "6, rue Fessart",
            "Hergé": "2-4, rue du Département",
            "James Baldwin": "10 bis, rue Henri Ribière",
            "Naguib Mahfouz": "66, rue des Couronnes",
            "Mortier": "113, boulevard Mortier",
            "Louise Michel": "29/35, rue des Haies",
            "Oscar Wilde": "12, rue du Télégraphe",
            "Maryse Condé": "17, rue Sorbier",
            "Marguerite Duras": "115, rue de Bagnolet",
            "Assia Djebar": "1, rue Reynaldo Hahn",
            "François Truffaut": "Forum des Halles, niveau -3, 4, rue du Cinéma",
            "Canopée": "10, passage de la Canopée",
            "Charlotte Delbo": "2, passage des Petits Pères",
            "Marguerite Audoux": "10, rue Portefoin",
            "Arthur Rimbaud": "2, place Baudoyer",
            "Hôtel de Ville": "Hôtel de Ville, 29 rue de Rivoli",
            "Forney": "Hôtel de Sens, 1, rue du Figuier",
            "Historique": "Hôtel Lamoignon, 24, rue Pavée",
            "Buffon": "15 bis, rue Buffon",
            "Littératures Policières": "48-50, rue du Cardinal Lemoine",
            "L’Heure Joyeuse": "6-12, rue des Prêtres-Saint-Séverin",
            "Mohammed Arkoun": "74-76, rue Mouffetard",
            "Rainer Maria Rilke": "88 ter, boulevard de Port-Royal",
            "André Malraux": "112, rue de Rennes",
            "Amélie": "164, rue de Grenelle",
            "Saint-Simon": "116 rue de Grenelle",
            "Agustina Bessa-Luís": "17 ter, avenue Beaucour",
            "Jean d’Ormesson": "Mairie, 3 rue de Lisbonne",
            "Louise Walser-Gaillard": "26, rue Chaptal",
            "Drouot": "11, rue Drouot",
            "Valeyre": "24, rue Marguerite de Rochechouart",
            "François Villon": "81, boulevard de la Villette",
            "Françoise Sagan": "8, rue Léon Schwartzenberg",
            "Heure Joyeuse": "8, rue Léon Schwartzenberg",
            "Claire Bretécher": "11, rue de Lancry",
            "Violette Leduc": "18, rue Faidherbe",
            "Toni Morrison": "20 bis, avenue Parmentier",
            "Diderot": "42, avenue Daumesnil",
            "Maison du Jardinage": "41, rue Paul Belmondo",
            "École Du Breuil": "Route de la ferme, Bois de Vincennes",
            "Hélène Berr": "70, rue de Picpus",
            "Paris nature": "Parc Floral",
            "Saint-Éloi": "23, rue du Colonel Rozanoff",
            "École Estienne": "18, boulevard Auguste-Blanqui",
            "Glacière": "132, rue de la Glacière",
            "Marina Tsvetaïeva": "132, rue de la Glacière",
            "Italie": "211-213, boulevard Vincent Auriol",
            "Jean-Pierre Melville": "79, rue Nationale",
            "Marguerite Durand": "79, rue Nationale",
            "Virginia Woolf": "4, rue Germ Krull",
            "Musicale": "Forum des Halles, -8, Porte Saint-Eustache"
        };
        
        function getAddress(biblioName) {
            const nameUpper = biblioName.toUpperCase();
            for (const [key, addr] of Object.entries(libraryAddresses)) {
                if (nameUpper.includes(key.toUpperCase())) {
                    return addr;
                }
            }
            return "";
        }

        const modal = document.createElement('div');
        modal.style.cssText = 'position: fixed; top: 5%; left: 5%; width: 90%; max-width: 800px; height: 90%; max-height: 90vh; background: #f9f9f9; border: 1px solid #ddd; z-index: 10000; padding: 30px; overflow-y: auto; box-shadow: 0 15px 40px rgba(0,0,0,0.6); border-radius: 12px; color: #333; font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;';
        
        let html = '<h2 style="margin-top: 0; color: #2c3e50; border-bottom: 2px solid #e2e8f0; padding-bottom: 15px;">🏁 Votre parcours de ramassage optimisé</h2><ul style="list-style-type: none; padding: 0;">';
        
        let clipboardText = "Parcours de ramassage :\n\n";

        route.forEach((step, index) => {
            const address = getAddress(step.biblio);
            const addressHtml = address ? `<div style="font-size: 0.85em; color: #666; margin-top: 3px; font-weight: normal;">📍 ${address}</div>` : '';
            const copyAddressText = address ? ` — ${address}` : '';

            // Alternance subtile des couleurs de fond
            const bgColor = index % 2 === 0 ? 'white' : '#f0f4f8';

            html += `<li style="margin-bottom: 15px; padding: 15px; border: 1px solid #e2e8f0; border-radius: 10px; background: ${bgColor}; box-shadow: 0 2px 5px rgba(0,0,0,0.04);">
                <h3 style="margin-top: 0; margin-bottom: 10px; color: #2980b9; font-size: 1.2em;">
                    🏛️ ${step.biblio} <span style="background: #e1f0fa; color: #2980b9; font-size: 0.75em; padding: 3px 8px; border-radius: 12px; margin-left: 5px;">${step.books.length} doc.</span>
                    ${addressHtml}
                </h3>
                <ul style="margin: 0; padding-left: 20px; list-style-type: disc; color: #444;">
                    ${step.books.map(b => `<li style="margin-bottom: 6px; line-height: 1.3;">
                        <strong style="color: #2c3e50;">${b.title}</strong> 
                        <span style="color: #7f8c8d; font-size: 0.9em; background: #fff; padding: 2px 6px; border-radius: 4px; border: 1px solid #eaeaea; font-family: monospace; margin-left: 8px;">📍 ${b.cote}</span>
                    </li>`).join('')}
                </ul>
            </li>`;

            // Ajout au texte pour le presse-papier
            clipboardText += `🏛️ ${step.biblio}${copyAddressText}\n`;
            step.books.forEach(b => {
                clipboardText += `  - ${b.title} (📍 ${b.cote})\n`;
            });
            clipboardText += `\n`;
        });
        
        html += `</ul>
        <div style="text-align: center; margin-top: 30px; display: flex; justify-content: center; gap: 15px;">
            <button id="copyToClipboardBtn" style="padding: 12px 20px; background: #27ae60; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600; box-shadow: 0 4px 6px rgba(39, 174, 96, 0.3);">📋 Copier le résumé</button>
            <button id="closeModalBtn" style="padding: 12px 20px; background: #e74c3c; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600; box-shadow: 0 4px 6px rgba(231, 76, 60, 0.3);">❌ Fermer</button>
        </div>`;
        modal.innerHTML = html;
        
        document.body.appendChild(modal);
        
        document.getElementById('closeModalBtn').addEventListener('click', () => modal.remove());
        
        // Logique de copie dans le presse-papier
        document.getElementById('copyToClipboardBtn').addEventListener('click', (e) => {
            navigator.clipboard.writeText(clipboardText).then(() => {
                const originalText = e.target.innerText;
                e.target.innerText = "✅ Copié !";
                e.target.style.background = "#2ecc71";
                setTimeout(() => {
                    e.target.innerText = originalText;
                    e.target.style.background = "#27ae60";
                }, 2000);
            }).catch(err => {
                console.error("Erreur copie", err);
                alert("Impossible de copier automatiquement. Autorisez le presse-papier.");
            });
        });
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
            
            // On extrait le vrai titre propre et l'auteur depuis l'API pour écraser "Livre (XXX)"
            let realTitle = item.title;
            if (apiRes?.d?.fieldList?.Title?.[0]) {
                realTitle = apiRes.d.fieldList.Title[0];
                // L'auteur se trouve souvent dans Author ou Author_sort
                const author = apiRes.d.fieldList.Author?.[0] || apiRes.d.fieldList.Author_sort?.[0];
                if (author) {
                    realTitle += ` (de ${author})`;
                }
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
