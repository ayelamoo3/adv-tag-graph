(function () {
    console.log("Tag Graph Plugin Loaded (vis)");

    // --- GRAPH STATE ---
    let nodes = new vis.DataSet();
    let edges = new vis.DataSet();
    let network = null;

    // --- API SECTION ---
    /** GRAPHQL QUERIES */
    async function gqlRequest(query, variables = {}) {
        const response = await fetch("/graphql", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables })
        });

        const json = await response.json();

        if (json.errors) {
            console.error("GraphQL Error:", json.errors);
            console.error("Query:", query);
            console.error("Variables:", variables);
            throw new Error("GraphQL error");
        }

        return json.data;
    }

    /** FETCH ALL TAGS */
    async function fetchTags() {
        const query = `
            query AllTagsHierarchy {
                allTags {
                    id
                    name
                    image_path
                    scene_count
                    image_count
                    parents { id }
                    children { id }
                }
            }
        `;

        const data = await gqlRequest(query);
        return data.allTags;
    }


    /** FETCH RELATED TAGS FOR SEARCH RESULTS */
    async function fetchTagsWithContext(tagIds) {
        const query = `
            query ($filter: FindFilterType, $tag_filter: TagFilterType) {
                findTags(filter: $filter, tag_filter: $tag_filter) {
                    tags {
                        id
                        name
                        image_path
                        scene_count
                        image_count
                        parents { id }
                        children { id }
                    }
                }
            }
        `;

        // Fetch all tags that match OR are related to matches
        const data = await gqlRequest(query, {
            tag_ids: tagIds
        });
        return data.findTags.tags;

    }

    // lightweight search
    async function searchTags(term) {
        if (!term) return [];

        const query = `
        query ($filter: FindFilterType, $tag_filter: TagFilterType) {
            findTags(filter: $filter, tag_filter: $tag_filter) {
                tags {
                    id
                    name
                }
            }
        }
    `;

        const data = await gqlRequest(query, {
            filter: {
                q: term,
                per_page: 8
            }
        });

        return data.findTags.tags;
    }

    /** FETCH TAG */
    async function getTag(tagId) {
        const query = `
        query ($id: ID!) {
            findTag(id: $id) {
                id
                parents { id }
            }
        }
    `;

        const data = await gqlRequest(query, { id: tagId });
        return data.findTag;
    }


    /** DELETE TAG */
    async function deleteTag(id) {
        const mutation = `
        mutation TagDestroy($input: TagDestroyInput!) {
            tagDestroy(input: $input)
        }
    `;

        // Stash tagDestroy returns a boolean (true if successful)
        return await gqlRequest(mutation, {
            input: { id: String(id) }
        });
    }



    /** CREATE NODE (TAG) */
    async function createTag(name) {
        const mutation = `
        mutation ($input: TagCreateInput!) {
            tagCreate(input: $input) {
                id
                name
                image_path
                scene_count
                image_count
            }
        }
    `;

        const data = await gqlRequest(mutation, {
            input: { name }
        });

        return data.tagCreate;
    }






    /** CREATE EDGE */
    async function createTagRelation(childId, parentId) {
        const tag = await getTag(childId);

        const existing = tag.parents.map(p => String(p.id));

        if (existing.includes(String(parentId))) {
            console.log("Parent already exists");
            return;
        }

        const updatedParents = [...existing, String(parentId)];

        const mutation = `
        mutation ($input: TagUpdateInput!) {
            tagUpdate(input: $input) { id }
        }
    `;

        await gqlRequest(mutation, {
            input: {
                id: childId,
                parent_ids: updatedParents
            }
        });

        // ADD EDGE LOCALLY (no full refresh)
        if (edges.get(`${parentId}-${childId}`)) return;
        edges.add({
            id: `${parentId}-${childId}`,
            from: String(parentId),
            to: String(childId)
        });
    }

    /** REMOVE EDGE */
    async function deleteTagRelation(childId, parentId) {
        const tag = await getTag(childId);

        const updatedParents = tag.parents
            .map(p => String(p.id))
            .filter(id => id !== String(parentId));

        const mutation = `
        mutation ($input: TagUpdateInput!) {
            tagUpdate(input: $input) { id }
        }
    `;

        await gqlRequest(mutation, {
            input: {
                id: childId,
                parent_ids: updatedParents
            }
        });

        // REMOVE EDGE LOCALLY
        edges.remove(`${parentId}-${childId}`);
    }



    // --- GRAPH SECTION ---
    /** BUILD GRAPH */
    function buildGraph(tags) {
        nodes.clear();
        edges.clear();

        tags.forEach(tag => {
            nodes.add({
                id: String(tag.id),
                value: tag.scene_count + tag.image_count,
                shape: "circularImage", // could also just use "image" here
                image: tag.image_path,
                label: tag.name
            });

            tag.parents.forEach(parent => {
                edges.add({
                    id: `${parent.id}-${tag.id}`,
                    from: String(parent.id),
                    to: String(tag.id)
                });
            });
        });
    }


    /** CREATE GRAPH */
    function createGraph(container) {
        network = new vis.Network(container, { nodes, edges }, {
            physics: {
                enabled: true,
                solver: "forceAtlas2Based",

                // forceAtlas2Based: {
                //     gravitationalConstant: -50,  // repulsion
                //     centralGravity: 0.01,        // pull to center
                //     springLength: 120,           // edge length
                //     springConstant: 0.08,        // stiffness
                //     damping: 0.4                 // friction
                // },

                // forceAtlas2Based: {
                //     gravitationalConstant: -80,  // repulsion
                //     centralGravity: 0.01,        // pull to center
                //     springLength: 120,           // edge length
                //     springConstant: 0.5,        // stiffness
                //     damping: 0.4                 // friction
                // },

                forceAtlas2Based: {
                    // theta: 0.5,
                    // gravitationalConstant: -50,  // moderate repulsion
                    gravitationalConstant: -100,  // moderate repulsion
                    centralGravity: 0.02,        // slight centering
                    springLength: 200,            // SHORT edges
                    // springLength: 250,            // SHORT edges
                    springConstant: .7,         // VERY stiff springs
                    // springConstant: .9,         // VERY stiff springs
                    // springConstant: 1.1,         // VERY stiff springs
                    damping: 0.8,                // responsive/snappy
                    avoidOverlap: 10,
                },

                stabilization: {
                    iterations: 200
                }
            },

            interaction: {
                hover: true,
                navigationButtons: false,
                tooltipDelay: 200
            },

            nodes: {
                color: {
                    border: "#adb5bd",
                    background: "#394b59",
                    highlight: {
                        border: "#137cbd",
                        background: "#FFFFFF"
                    }
                },
                font: { color: "white" },
            },
            edges: {
                color: "#FFFFFF",
                arrows: {
                    from: { enabled: true }
                }
            },

            layout: {
                improvedLayout: false
            }

        });

        // --- CLICK INTERACTIONS ---
        /** double-click FOR tag navigation */
        network.on("doubleClick", function (params) {
            if (!params.nodes.length) return;

            const id = params.nodes[0];
            console.log("Clicked tag:", id);

            // Navigate to tag page
            window.location.href = `/tags/${id}`;
        });

        // version 1
        /** right-click for context menu */
        network.on("oncontext", function (params) {
            params.event.preventDefault();

            const pointer = params.pointer.DOM;

            const nodeId = network.getNodeAt(pointer);
            const edgeId = network.getEdgeAt(pointer);

            if (nodeId) {
                showContextMenu(pointer, { type: "node", id: nodeId });
            } else if (edgeId) {
                showContextMenu(pointer, { type: "edge", id: edgeId });
            } else {
                showContextMenu(pointer, { type: "canvas" });
            }
        });

    }


    // Replace the renderGraph and destroyGraph functions with:

    /** RENDER GRAPH - AS SEPARATE PAGE */
    async function renderGraphPage() {
        // Check if we're already on the graph page
        if (window.location.pathname === "/tag-graph") {
            return;
        }

        // Navigate to the graph page
        window.location.href = "/tag-graph";
    }

    /** HANDLE GRAPH PAGE */
    async function handleGraphPageLoad() {
        // Only run if we're on the graph page
        if (window.location.pathname !== "/tag-graph") {
            return;
        }


        // --- HIGH LIGHT ACTIVE STATE ---
        // We check for the button; if it's not there yet, addNavButton will handle it 
        // when it eventually spawns, but we try here first.
        const navBtn = document.getElementById("tag-graph-btn");
        if (navBtn) navBtn.classList.add("active");


        console.log(window.vis);
        if (!window.vis) {
            console.error("vis-network not loaded");
            return;
        }


        const tags = await fetchTags();

        // Create a clean container that fills the page below the navbar
        let container = document.getElementById("tag-graph-container");
        if (!container) {
            container = document.createElement("div");
            container.id = "tag-graph-container";
            container.style.position = "fixed";
            container.style.top = "56px";  // Adjust based on your navbar height
            container.style.left = "0";
            container.style.right = "0";
            container.style.bottom = "0";
            container.style.width = "100%";
            container.style.height = "calc(100% - 56px)";
            document.body.appendChild(container);
        }

        container.innerHTML = "";

        const graphDiv = document.createElement("div");
        graphDiv.style.width = "100%";
        graphDiv.style.height = "100%";
        container.appendChild(graphDiv);

        nodes.clear();
        edges.clear();

        buildGraph(tags);
        createGraph(graphDiv);

        createSearchBox(container);
    }

    /** DESTROY GRAPH */
    function destroyGraph() {
        if (network) {
            network.destroy();
            network = null;
        }

        const container = document.getElementById("tag-graph-container");
        if (container) {
            container.remove();
        }
    }


    /** handle search (version 5)*/
    /** SEARCH BY TAG ID - use existing graph, just filter visibility */
    async function handleSearchById(tagId) {
        if (!tagId) {
            resetSearch();
            return;
        }

        // Get the tag's full context
        const contextTags = await fetchTagsWithContext([tagId]);
        if (contextTags.length === 0) return;

        // Build a set of IDs we want to show (the tag + its parents/children)
        const visibleIds = new Set();
        const toProcess = [String(tagId)];
        const processed = new Set();

        while (toProcess.length > 0) {
            const id = toProcess.pop();
            if (processed.has(id)) continue;
            processed.add(id);
            visibleIds.add(id);

            const tag = contextTags.find(t => String(t.id) === id);
            if (tag) {
                tag.parents.forEach(p => toProcess.push(String(p.id)));
                tag.children.forEach(c => toProcess.push(String(c.id)));
            }
        }

        // Hide/show nodes based on visibility set
        nodes.forEach(node => {
            const visible = visibleIds.has(node.id);
            nodes.update({
                id: node.id,
                hidden: !visible,
                color: visible && node.id === String(tagId) ? {
                    background: "#ffcc00",
                    border: "#ff9900"
                } : undefined
            });
        });

        // Hide edges where either endpoint is hidden
        edges.forEach(edge => {
            edges.update({
                id: edge.id,
                hidden: !visibleIds.has(edge.from) || !visibleIds.has(edge.to)
            });
        });

        network.fit({ animation: true });
    }

    async function handleSearch(query) {
        if (!query || query.trim() === "") {
            resetSearch();
            return;
        }

        const matchResults = await searchTags(query);
        if (matchResults.length === 0) {
            console.log("No results found");
            return;
        }

        // If only one result, search by ID instead
        if (matchResults.length === 1) {
            await handleSearchById(matchResults[0].id);
            return;
        }

        // Multiple results: show all of them + their context
        const allContextTags = await fetchTagsWithContext(matchResults.map(t => t.id));
        const visibleIds = new Set(allContextTags.map(t => String(t.id)));
        const matchIds = new Set(matchResults.map(t => String(t.id)));

        nodes.forEach(node => {
            const visible = visibleIds.has(node.id);
            nodes.update({
                id: node.id,
                hidden: !visible,
                color: visible && matchIds.has(node.id) ? {
                    background: "#ffcc00",
                    border: "#ff9900"
                } : undefined
            });
        });

        edges.forEach(edge => {
            edges.update({
                id: edge.id,
                hidden: !visibleIds.has(edge.from) || !visibleIds.has(edge.to)
            });
        });

        network.fit({ animation: true });
    }

    function resetSearch() {
        // Just unhide everything, don't rebuild
        nodes.forEach(node => {
            nodes.update({ id: node.id, hidden: false, color: undefined });
        });

        edges.forEach(edge => {
            edges.update({ id: edge.id, hidden: false });
        });

        network.fit({ animation: true });
    }

    /** SEARCH UI - UNIFIED */
    function createSearchBox(container) {
        const wrapper = document.createElement("div");

        Object.assign(wrapper.style, {
            position: "absolute",
            top: "10px",
            left: "10px",
            zIndex: 10001
        });

        const input = document.createElement("input");
        input.placeholder = "Search tags...";

        const dropdown = document.createElement("div");
        let currentResults = [];
        let selectedIndex = 0;

        Object.assign(input.style, {
            padding: "6px",
            background: "#222",
            color: "white",
            border: "1px solid #555",
            width: "200px",
            display: "block"
        });

        Object.assign(dropdown.style, {
            background: "#222",
            border: "1px solid #555",
            marginTop: "2px",
            maxHeight: "200px",
            overflowY: "auto",
            minWidth: "200px"
        });

        const updateDropdown = async () => {
            const query = input.value.trim();
            selectedIndex = 0;
            dropdown.innerHTML = "";

            if (!query) return;

            currentResults = await searchTags(query);

            currentResults.forEach((tag, index) => {
                const item = document.createElement("div");
                item.innerText = tag.name;

                Object.assign(item.style, {
                    padding: "4px 8px",
                    cursor: "pointer",
                    background: index === selectedIndex ? "#555" : "transparent"
                });

                item.onclick = async () => {
                    input.value = tag.name;
                    await handleSearchById(tag.id);
                    dropdown.innerHTML = "";
                };

                item.onmouseover = () => item.style.background = "#444";
                item.onmouseout = () => {
                    item.style.background = index === selectedIndex ? "#555" : "transparent";
                };

                dropdown.appendChild(item);
            });
        };

        input.addEventListener("input", updateDropdown);

        input.addEventListener("keydown", async (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const query = input.value.trim();
                if (query) {
                    if (currentResults.length > 0) {
                        await handleSearchById(currentResults[selectedIndex].id);
                    } else {
                        await handleSearch(query);
                    }
                    dropdown.innerHTML = "";
                }
            }

            if (e.key === "Escape") {
                input.value = "";
                dropdown.innerHTML = "";
                resetSearch();
            }

            if (e.key === "ArrowDown") {
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
                await updateDropdown();
            }

            if (e.key === "ArrowUp") {
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                await updateDropdown();
            }
        });

        wrapper.appendChild(input);
        wrapper.appendChild(dropdown);
        container.appendChild(wrapper);
    }



    function showTagSearchModal(onSelect) {
        const modal = document.createElement("div");

        Object.assign(modal.style, {
            position: "fixed",
            top: "30%",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#222",
            padding: "10px",
            border: "1px solid #555",
            zIndex: 10002,
            width: "250px"
        });

        const input = document.createElement("input");
        const resultsDiv = document.createElement("div");
        let currentResults = [];
        let selectedIndex = 0;

        Object.assign(input.style, {
            width: "100%",
            marginBottom: "6px",
            padding: "4px",
            background: "#111",
            color: "white",
            border: "1px solid #555"
        });

        Object.assign(resultsDiv.style, {
            maxHeight: "200px",
            overflowY: "auto"
        });

        input.placeholder = "Search tag...";

        const updateResults = async () => {
            currentResults = await searchTags(input.value);
            selectedIndex = 0;
            resultsDiv.innerHTML = "";

            currentResults.forEach((tag, index) => {
                const item = document.createElement("div");
                item.innerText = tag.name;

                if (index === selectedIndex) {
                    item.style.background = "#555";
                }

                Object.assign(item.style, {
                    padding: "4px",
                    cursor: "pointer"
                });

                item.onclick = () => {
                    onSelect(tag);
                    modal.remove();
                };

                item.onmouseover = () => item.style.background = "#444";
                item.onmouseout = () => {
                    item.style.background = index === selectedIndex ? "#555" : "transparent";
                };

                resultsDiv.appendChild(item);
            });
        };

        input.oninput = updateResults;

        input.addEventListener("keydown", async (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                if (currentResults.length > 0) {
                    onSelect(currentResults[selectedIndex]);
                    modal.remove();
                }
            }

            if (e.key === "Escape") {
                e.preventDefault();
                modal.remove();
            }

            if (e.key === "ArrowDown") {
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
                await updateResults();
            }

            if (e.key === "ArrowUp") {
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                await updateResults();
            }
        });

        modal.appendChild(input);
        modal.appendChild(resultsDiv);
        document.body.appendChild(modal);

        const clickHandler = (e) => {
            if (!modal.contains(e.target)) {
                modal.remove();
                document.removeEventListener("click", clickHandler);
            }
        };

        setTimeout(() => {
            document.addEventListener("click", clickHandler);
        }, 0);

        input.focus();
    }


    function showConfirmModal(message, onConfirm) {
        const modal = document.createElement("div");
        Object.assign(modal.style, {
            position: "fixed",
            top: "30%",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#222",
            padding: "20px",
            border: "1px solid #ff4444", // Red border to indicate danger
            zIndex: 10005,
            width: "300px",
            textAlign: "center",
            color: "white"
        });

        const text = document.createElement("p");
        text.innerText = message;
        text.style.marginBottom = "20px";

        const btnContainer = document.createElement("div");
        btnContainer.style.display = "flex";
        btnContainer.style.justifyContent = "space-around";

        const confirmBtn = document.createElement("button");
        confirmBtn.innerText = "Delete";
        confirmBtn.style.background = "#cc0000";
        confirmBtn.style.color = "white";
        confirmBtn.style.border = "none";
        confirmBtn.style.padding = "5px 15px";
        confirmBtn.style.cursor = "pointer";

        const cancelBtn = document.createElement("button");
        cancelBtn.innerText = "Cancel";
        cancelBtn.style.background = "#555";
        cancelBtn.style.color = "white";
        cancelBtn.style.border = "none";
        cancelBtn.style.padding = "5px 15px";
        cancelBtn.style.cursor = "pointer";

        const close = () => modal.remove();

        confirmBtn.onclick = () => {
            onConfirm();
            close();
        };
        cancelBtn.onclick = close;

        modal.appendChild(text);
        btnContainer.appendChild(cancelBtn);
        btnContainer.appendChild(confirmBtn);
        modal.appendChild(btnContainer);
        document.body.appendChild(modal);
    }

    // --- HOTKEY SYSTEM ---
    let activeContext = null;
    const hotkeys = {
        'd': (context) => {
            if (context.type === "edge") {
                const edge = edges.get(context.id);
                if (!edge) return;
                deleteTagRelation(edge.to, edge.from);
            }

            else if (context.type === "node") {
                const nodeData = nodes.get(context.id);
                showConfirmModal(`Delete "${nodeData.label}"?`, async () => {
                    await deleteTag(context.id);
                    nodes.remove(context.id);
                });
            }
        },
        'v': (context) => {
            if (context.type === "node") { //for viewing
                window.location.href = `/tags/${context.id}`;
            }
        },
        'a': (context) => {
            if (context.type === "node") { //for add parent
                showTagSearchModal(async (tag) => {
                    await createTagRelation(context.id, tag.id);
                });
            }
        },
        'c': (context) => {
            if (context.type === "node") { //for adding child
                showTagSearchModal(async (tag) => {
                    await createTagRelation(tag.id, context.id);
                });
            }
        }
        // Add more hotkeys here as needed
    };

    function registerHotkeys() {
        document.addEventListener("keydown", (e) => {
            // Only trigger if a context menu is open
            if (!activeContext) return;

            const key = e.key.toLowerCase();
            if (hotkeys[key]) {
                e.preventDefault();
                hotkeys[key](activeContext);
                removeContextMenu();
                activeContext = null;
            }
        });
    }


    function showCreateTagsModal(onSubmit) {
        const modal = document.createElement("div");

        Object.assign(modal.style, {
            position: "fixed",
            top: "30%",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#222",
            padding: "10px",
            border: "1px solid #555",
            zIndex: 10002,
            width: "300px"
        });

        const textarea = document.createElement("textarea");

        Object.assign(textarea.style, {
            width: "100%",
            height: "100px",
            marginBottom: "6px",
            background: "#111",
            color: "white",
            border: "1px solid #555"
        });

        textarea.placeholder = "Enter tags (comma or newline separated)";

        const btn = document.createElement("button");
        btn.innerText = "Create";

        const closeModal = () => {
            modal.remove();
            document.removeEventListener("click", clickHandler);
        };

        btn.onclick = async () => {
            const names = textarea.value
                .split(/[\n,]/)
                .map(s => s.trim())
                .filter(Boolean);

            await onSubmit(names);
            closeModal();
        };

        textarea.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                closeModal();
            }
        });

        modal.appendChild(textarea);
        modal.appendChild(btn);
        document.body.appendChild(modal);

        const clickHandler = (e) => {
            if (!modal.contains(e.target)) {
                closeModal();
            }
        };

        setTimeout(() => {
            document.addEventListener("click", clickHandler);
        }, 0);

        textarea.focus();
    }


    /** SHOW MENU */
    function showContextMenu(position, context) {
        removeContextMenu();
        activeContext = context;

        const menu = document.createElement("div");
        menu.id = "graph-context-menu";

        Object.assign(menu.style, {
            position: "fixed",
            top: position.y + "px",
            left: position.x + "px",
            background: "#222",
            border: "1px solid #555",
            padding: "6px",
            zIndex: 10000,
            minWidth: "140px"
        });

        if (context.type === "node") {
            const nodeId = context.id;
            const nodeData = nodes.get(nodeId); // Get node data for the label

            menu.appendChild(menuItem("Go to Tag", () => {
                window.location.href = `/tags/${nodeId}`;
            }));

            menu.appendChild(menuItem("Add Parent", () => {
                showTagSearchModal(async (tag) => {
                    await createTagRelation(nodeId, tag.id);
                });
            }));

            menu.appendChild(menuItem("Add Child", () => {
                showTagSearchModal(async (tag) => {
                    await createTagRelation(tag.id, nodeId);
                });
            }));

            menu.appendChild(menuItem("Remove All Parents", async () => {
                const tag = await getTag(nodeId);

                for (const p of tag.parents) {
                    await deleteTagRelation(nodeId, p.id);
                }
            }));

            // Add a separator for visual clarity
            const hr = document.createElement("hr");
            hr.style.border = "0.5px solid #444";
            menu.appendChild(hr);

            menu.appendChild(menuItem("Delete Tag Permanently", () => {
                showConfirmModal(`Are you sure you want to delete the tag "${nodeData.label}"? This cannot be undone.`, async () => {
                    try {
                        await deleteTag(nodeId);
                        // Remove from the local graph UI
                        nodes.remove(nodeId);
                        // vis.js automatically removes associated edges when a node is deleted
                        console.log(`Deleted tag: ${nodeId}`);
                    } catch (err) {
                        console.error("Failed to delete tag:", err);
                        alert("Error deleting tag. Check console for details.");
                    }
                });
            }));

        }

        else if (context.type === "edge") {
            const edge = edges.get(context.id);

            if (!edge) return;

            const parentId = edge.from;
            const childId = edge.to;

            menu.appendChild(menuItem("Go to Parent", () => {
                window.location.href = `/tags/${parentId}`;
            }));

            menu.appendChild(menuItem("Go to Child", () => {
                window.location.href = `/tags/${childId}`;
            }));

            menu.appendChild(menuItem("Delete Relationship", async () => {
                await deleteTagRelation(childId, parentId);
            }));
        }


        else if (context.type === "canvas") {
            // Store the right-click position

            menu.appendChild(menuItem("Add Tag(s)", () => {
                showCreateTagsModal(async (names) => {
                    for (const name of names) {
                        const tag = await createTag(name);

                        nodes.add({
                            id: String(tag.id),
                            label: tag.name,
                            value: tag.scene_count + tag.image_count,
                            shape: "circularImage",
                            image: tag.image_path || "",
                            // Don't set x/y - let physics engine position it
                        });
                    }
                });
            }));

        }

        document.body.appendChild(menu);
    }

    /** MENU ITEM */
    function menuItem(label, onClick) {
        const item = document.createElement("div");
        item.innerText = label;

        Object.assign(item.style, {
            padding: "4px 8px",
            cursor: "pointer"
        });

        item.onclick = () => {
            onClick();
            removeContextMenu();
        };

        item.onmouseover = () => item.style.background = "#444";
        item.onmouseout = () => item.style.background = "transparent";

        return item;
    }

    /** REMOVE MENU */
    function removeContextMenu() {
        const existing = document.getElementById("graph-context-menu");
        if (existing) existing.remove();
        activeContext = null;

    }



    // --- ADD NAV BUTTON ---
    function addNavButton() {
        const attemptAdd = () => {
            const nav = document.querySelector(".navbar-nav");
            if (!nav) return false;

            if (document.getElementById("tag-graph-btn")) {
                return true; // Already added
            }

            const li = document.createElement("li");
            li.className = "nav-item";

            const btn = document.createElement("a");
            btn.className = "nav-link";
            btn.id = "tag-graph-btn";
            btn.href = "#";
            btn.setAttribute("role", "button");

            const icon = document.createElement("img");
            icon.src = "/plugins/adv-tag-graph/_assets/tag-graph-menu-icon.svg";
            icon.style.width = "1.25rem";
            icon.style.height = "1.25rem";
            icon.style.marginRight = "0.5rem";

            const label = document.createElement("span");
            label.innerText = "Tag Graph";

            btn.appendChild(icon);
            btn.appendChild(label);

            btn.onclick = (e) => {
                e.preventDefault();
                renderGraphPage();
            };

            li.appendChild(btn);
            nav.appendChild(li);

            return true; // Success
        };

        // Try immediately
        if (attemptAdd()) return;

        // If not ready, use observer to retry
        const observer = new MutationObserver(() => {
            if (attemptAdd()) {
                observer.disconnect();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }


    // function addNavButton() {
    //     const interval = setInterval(() => {
    //         const nav = document.querySelector(".navbar-nav");

    //         if (!nav) return;

    //         if (document.getElementById("tag-graph-btn")) {
    //             clearInterval(interval);
    //             return;
    //         }

    //         const li = document.createElement("li");
    //         li.className = "nav-item";

    //         const btn = document.createElement("a");
    //         btn.className = "nav-link";
    //         btn.id = "tag-graph-btn";
    //         btn.href = "#";
    //         btn.setAttribute("role", "button");

    //         // Create the Icon element
    //         const icon = document.createElement("img");
    //         icon.src = "/plugins/adv-tag-graph/assets/tag-graph-menu-icon.svg";
    //         icon.style.width = "1.25rem";
    //         icon.style.height = "1.25rem";
    //         icon.style.marginRight = "0.5rem";

    //         const label = document.createElement("span");
    //         label.innerText = "Tag Graph";

    //         btn.appendChild(icon);
    //         btn.appendChild(label);

    //         btn.onclick = (e) => {
    //             e.preventDefault();
    //             renderGraphPage();
    //         };

    //         li.appendChild(btn);
    //         nav.appendChild(li);

    //         clearInterval(interval);
    //     }, 1000);
    // }

    // function addNavButton() {
    //     const interval = setInterval(() => {
    //         const nav = document.querySelector(".navbar-nav");

    //         if (!nav) return;

    //         // Prevent duplicate buttons
    //         if (document.getElementById("tag-graph-btn")) {
    //             clearInterval(interval);
    //             return;
    //         }

    //         const li = document.createElement("li");
    //         li.className = "nav-item";

    //         const btn = document.createElement("a");
    //         btn.className = "nav-link";
    //         btn.id = "tag-graph-btn";
    //         btn.href = "#";
    //         btn.setAttribute("role", "button");

    //         // Create the Icon element
    //         const icon = document.createElement("img");
    //         // Ensure this path matches your plugin's folder name in /plugins/
    //         icon.src = "/plugins/tag-graph-plugin/assets/tag-graph-menu-icon.svg";

    //         // Match Stash's native icon sizing and alignment
    //         Object.assign(icon.style, {
    //             width: "1.25rem",
    //             height: "1.25rem",
    //             marginRight: "0.5rem",
    //             verticalAlign: "middle",
    //             display: "inline-block",
    //             // This filter makes the SVG white to match the navbar text
    //             filter: "invert(100%) brightness(200%)"
    //         });

    //         const label = document.createElement("span");
    //         label.innerText = "Tag Graph";
    //         label.style.verticalAlign = "middle";

    //         btn.appendChild(icon);
    //         btn.appendChild(label);

    //         btn.onclick = (e) => {
    //             e.preventDefault();
    //             renderGraphPage();
    //         };

    //         li.appendChild(btn);
    //         nav.appendChild(li);

    //         clearInterval(interval);
    //     }, 1000);
    // }

    // function addNavButton() {
    //     const interval = setInterval(() => {
    //         const nav = document.querySelector(".navbar-nav");

    //         if (!nav) return;

    //         if (document.getElementById("tag-graph-btn")) {
    //             clearInterval(interval);
    //             return;
    //         }

    //         const li = document.createElement("li");
    //         li.className = "nav-item";

    //         const btn = document.createElement("a");
    //         btn.className = "nav-link";
    //         btn.id = "tag-graph-btn";
    //         btn.href = "#";
    //         // btn.innerText = "Tag Graph";


    //         // Add Font Awesome icon - Font Awesome 6 is loaded
    //         const icon = document.createElement("i");
    //         icon.className = "fa fa-share-nodes";  // Use fa-share-nodes (more common in FA6)
    //         icon.style.marginRight = "5px";

    //         const label = document.createElement("span");
    //         label.innerText = "Tag Graph";

    //         btn.appendChild(icon);
    //         btn.appendChild(label);

    //         btn.onclick = (e) => {
    //             e.preventDefault();
    //             renderGraphPage();
    //         };

    //         li.appendChild(btn);
    //         nav.appendChild(li);

    //         console.log("Tag Graph button added with Font Awesome icon");
    //         clearInterval(interval);
    //     }, 1000);

    //     //     // Check if Font Awesome is loaded
    //     //     if (!window.FontAwesome && !document.querySelector('link[href*="font-awesome"]')) {
    //     //         console.warn("Font Awesome not detected, using text fallback");
    //     //         btn.innerText = "📊 Tag Graph";
    //     //     } else {
    //     //         // Add Font Awesome icon
    //     //         const icon = document.createElement("i");
    //     //         // icon.className = "fa fa-project-diagram";  // Graph/network icon
    //     //         // icon.className = "fa fa-sitemap";  // Tree/hierarchy icon (more likely to exist)
    //     //         icon.className = "fa fa-share";  // Tree/hierarchy icon (more likely to exist)
    //     //         icon.style.marginRight = "5px";

    //     //         const label = document.createElement("span");
    //     //         label.innerText = "Tag Graph";

    //     //         btn.appendChild(icon);
    //     //         btn.appendChild(label);
    //     //     }

    //     //     btn.onclick = (e) => {
    //     //         e.preventDefault();
    //     //         renderGraphPage();  // Changed from renderGraph() to renderGraphPage()
    //     //     };

    //     //     li.appendChild(btn);
    //     //     nav.appendChild(li);

    //     //     console.log("Tag Graph button added");
    //     //     clearInterval(interval);
    //     // }, 1000);
    // }

    // --- WATCH NAVIGATION ---
    function watchNavigation() {
        let lastUrl = location.href;

        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;

                // Only destroy if leaving the graph page
                if (!location.pathname.includes("/tag-graph")) {
                    destroyGraph();  // Comment this out for now - we don't have destroyGraph() defined
                }
            }
        }, 500);
    }

    function injectStyles() {
        const style = document.createElement("style");
        style.innerHTML = `
        #tag-graph-btn {
            display: inline-flex;
            align-items: center;
        }
        
        #tag-graph-btn img {
            opacity: 0.7;
            transition: opacity 0.2s ease;
        }
        
        #tag-graph-btn:hover img {
            opacity: 1;
        }
        
        #tag-graph-btn.active img {
            opacity: 1;
        }
        
        #tag-graph-container {
            background-color: #111;
        }
    `;
        document.head.appendChild(style);
    }

    // function injectStyles() {
    //     const style = document.createElement("style");
    //     style.innerHTML = `
    //     /* Match Stash's hover transparency for nav icons */
    //     .nav-item #tag-graph-btn img {
    //         opacity: 0.8;
    //         transition: opacity 0.2s;
    //     }
    //     .nav-item #tag-graph-btn:hover img, 
    //     .nav-item #tag-graph-btn.active img {
    //         opacity: 1;
    //     }
    //     /* Ensure the container doesn't overlap the navbar */
    //     #tag-graph-container {
    //         background-color: #111; /* Match Stash's dark theme background */
    //     }
    // `;
    //     document.head.appendChild(style);
    // }

    // --- INIT ---
    function init() {
        console.log("Initializing Tag Graph Plugin...");

        // 1. Inject styles first so UI is ready
        injectStyles();

        // 2. Set up listeners
        document.addEventListener("click", (e) => {
            const menu = document.getElementById("graph-context-menu");
            if (menu && !menu.contains(e.target)) {
                removeContextMenu();
            }
        });
        registerHotkeys();
        addNavButton();
        watchNavigation();

        // Check if we're loading the graph page
        handleGraphPageLoad();
    }

    init();

})();

