/*
 * Copyright (c) 2026 SwimLikeAnOtter
 * SPDX-License-Identifier: 0BSD
 *
 * Free to use, copy, modify and distribute for any purpose,
 * including commercial use. No attribution required.
 *
 * This software is provided "AS IS", without warranty of
 * any kind. The author accepts no liability arising from
 * its use.
 *
 * Please use it responsibly and don't be naughty!
 *
 * See LICENSE for the full licence text.
 *
 */

let canvas;
let gl;
let movementMatrix = [];
let matrixStack = [];
let shaderProgram;
let vertexPositionAttribute;
let textureCoordAttribute;
let vertexNormalAttribute;
let terrainChunks = new Map();
let cottageTextures;
let rockTexture;
let treeTrunkTexture;
let treeCrownTexture;
let fps = 0;
let frames = 0;
let currentChunkX = null;
let currentChunkZ = null;
let x_location = 0;
let z_location = -500;
let y_location = -100;
let y_camera_angle = 15;
let camera_angle = 150;
let player_speed = 1.0;
let player_rotation_speed = 0;
let movement_direction = 0;
let acceleration = 0;
let rotate_direction = 0;
let terrainTexture;
let personTextures;
let personCloakPalettes;
let lastPeopleUpdate = performance.now();
let gameplayUpdates = 0;

// Mobile analogue input, independent of keyboard input.
const touchMove = { x: 0, y: 0 };
const touchLook = { x: 0, y: 0 };

function InitTouchControls() {
    const resetters = [];

    function bindStick(id, input) {
        const pad = document.getElementById(id);
        const knob = pad.querySelector('.touch-knob');
        let pointer = null;

        function reset() {
            const oldPointer = pointer;
            pointer = null;
            input.x = input.y = 0;
            knob.style.transform = 'translate(-50%, -50%)';
            if (oldPointer !== null && pad.hasPointerCapture(oldPointer)) {
                pad.releasePointerCapture(oldPointer);
            }
        }

        function update(e) {
            const rect = pad.getBoundingClientRect();
            const radius = rect.width * 0.32;
            const dx = (e.clientX - rect.left - rect.width / 2) / radius;
            const dy = (e.clientY - rect.top - rect.height / 2) / radius;
            const length = Math.hypot(dx, dy);
            const divisor = Math.max(1, length);
            const x = dx / divisor;
            const y = dy / divisor;
            knob.style.transform = `translate(-50%, -50%) translate(${x * radius}px, ${y * radius}px)`;

            // Small dead zone, with a continuous transition outside it.
            const magnitude = Math.min(1, length);
            const strength = Math.max(0, (magnitude - 0.12) / 0.88);
            input.x = length ? dx / length * strength : 0;
            input.y = length ? dy / length * strength : 0;
        }

        pad.addEventListener('pointerdown', e => {
            if (pointer !== null) return;
            e.preventDefault();
            pointer = e.pointerId;
            pad.setPointerCapture(pointer);
            update(e);
        });
        pad.addEventListener('pointermove', e => {
            if (e.pointerId === pointer) update(e);
        });
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            pad.addEventListener(event, e => {
                if (e.pointerId === pointer) reset();
            });
        }
        resetters.push(reset);
    }

    bindStick('touchMove', touchMove);
    bindStick('touchLook', touchLook);

    function resetControls() {
        for (const reset of resetters) reset();
    }
    window.addEventListener('blur', resetControls);
    window.addEventListener('orientationchange', resetControls);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) resetControls();
    });
}

function ControlTouchMovement(dt) {
    // Right stick: yaw and pitch, in degrees per second.
    const touchTurnSpeed = 30;
    const touchPitchSpeed = 15;
    if (touchLook.x !== 0) {
        camera_angle = (camera_angle + touchLook.x * touchTurnSpeed * dt + 360) % 360;
    }
    if (touchLook.y !== 0) {
        y_camera_angle = Math.max(-35, Math.min(55,
            y_camera_angle + touchLook.y * touchPitchSpeed * dt));
    }

    // Left stick: use the same inverse camera coordinates as the keyboard.
    const forward = -touchMove.y;
    const sideways = touchMove.x;
    if (forward === 0 && sideways === 0) return;

    const angle = camera_angle * Math.PI / 180;
    const distance = (player_speed + acceleration) * 240 * dt;

    x_location -= (Math.sin(angle) * forward + Math.cos(angle) * sideways) * distance;
    z_location += (Math.cos(angle) * forward - Math.sin(angle) * sideways) * distance;
}


window.addEventListener("keydown", checkKeyPressed, false);
window.addEventListener("keyup", checkKeyUnPressed, false);

function CreateChunkCottages(chunkX, chunkZ) {

    const cottages = [];

    // Each chunk gets repeatable randomness.
    let seed = (
        Math.imul(chunkX, 9147823) ^
        Math.imul(chunkZ, 7297193) ^
        87654
    ) >>> 0;

    function random() {
        seed = (
            Math.imul(1664525, seed) + 1013904223
        ) >>> 0;
        return seed / 4294967296;
    }

    // Most chunks have no houses.
    if (random() > 0.12) {
        return cottages;
    }

    // Usually one cottage, occasionally two.
    const count = random() < 0.20 ? 2 : 1;

    for (let i = 0; i < count; i++) {

        const x = chunkX * 800 - 300 + random() * 600;
        const z = chunkZ * 800 - 300 + random() * 600;

        const house = generateCottage(x, z);

        cottages.push({
            walls: makeTreeBuffers(house.walls),
            roof: makeTreeBuffers(house.roof),
            door: makeTreeBuffers(house.door),
            windows: makeTreeBuffers(house.windows)
        });
    }

    return cottages;
}


function CreateChunkTrees(chunkX, chunkZ) {

    const chunkTrees = [];

    // A unique, repeatable seed for each chunk.
    let seed = (
        Math.imul(chunkX, 83492791) ^
        Math.imul(chunkZ, 29765797) ^
        54321
    ) >>> 0;

    function random() {
        seed = (
            Math.imul(1664525, seed) + 1013904223
        ) >>> 0;

        return seed / 4294967296;
    }

    // Try twelve possible tree positions per chunk.
    for (let i = 0; i < 12; i++) {

        const x = chunkX * 800 - 350 + random() * 700;
        const z = chunkZ * 800 - 350 + random() * 700;

        // Use the same regional signal as our hills.
        const region = regionalNoise(x, z, 3800);

        let t = (region - 0.28) / 0.44;
        t = Math.max(0, Math.min(1, t));

        // Smooth transition from plains to highlands.
        const hilliness = t * t * (3 - 2 * t);

        // Maximum tree density in rolling countryside.
        const rolling = 4 * hilliness * (1 - hilliness);

        const treeChance = 0.25 + 0.55 * rolling;

        // Not every candidate becomes a tree.
        if (random() > treeChance) {
            continue;
        }

        const tree = generateTree(x, z);

        chunkTrees.push({
            trunk: makeTreeBuffers(tree.trunk),
            crown: makeTreeBuffers(tree.crown)
        });
    }

    return chunkTrees;
}

function UpdateTerrainChunks() {

    const required = new Set();

    // Keep our 5 x 5 landscape.
    for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {

            const x = currentChunkX + dx;
            const z = currentChunkZ + dz;
            const key = x + "," + z;

            required.add(key);

            // Generate a missing chunk and its scenery.
            if (!terrainChunks.has(key)) {
                terrainChunks.set(
                    key,
                    CreateTerrainChunk(x, z)
                );
            }
        }
    }

    // Remove chunks that are no longer needed.
    for (const [key, chunk] of terrainChunks) {

        if (!required.has(key)) {

            // Terrain.
            gl.deleteBuffer(chunk.vertices);
            gl.deleteBuffer(chunk.indices);
            gl.deleteBuffer(chunk.texture);
            gl.deleteBuffer(chunk.normals);

            // Rocks.
            for (const rock of chunk.rocks) {
                gl.deleteBuffer(rock.vertices);
                gl.deleteBuffer(rock.indices);
                gl.deleteBuffer(rock.texture);
                gl.deleteBuffer(rock.normals);
            }

            // Trees.
            for (const tree of chunk.trees) {
                for (const part of [tree.trunk, tree.crown]) {
                    gl.deleteBuffer(part.vertices);
                    gl.deleteBuffer(part.indices);
                    gl.deleteBuffer(part.texture);
                    gl.deleteBuffer(part.normals);
                }
            }

            // Cottages.
            for (const house of chunk.cottages) {
                for (const part of [
                    house.walls,
                    house.roof,
                    house.door,
                    house.windows
                ]) {
                    gl.deleteBuffer(part.vertices);
                    gl.deleteBuffer(part.indices);
                    gl.deleteBuffer(part.texture);
                    gl.deleteBuffer(part.normals);
                }
            }

            // Delete inhabitants belonging to this chunk.
            for (const person of chunk.people) {
                for (const mesh of Object.values(person)) {
                    gl.deleteBuffer(mesh.vertices);
                    gl.deleteBuffer(mesh.indices);
                    gl.deleteBuffer(mesh.texture);
                    gl.deleteBuffer(mesh.normals);
                }
            }

            // Delete inhabitants belonging to this chunk.
            for (const person of chunk.people) {

                for (const mesh of Object.values(person.meshes)) {

                    gl.deleteBuffer(mesh.vertices);
                    gl.deleteBuffer(mesh.indices);
                    gl.deleteBuffer(mesh.texture);
                    gl.deleteBuffer(mesh.normals);
                }
            }

            // Remove the chunk after all its buffers.
            terrainChunks.delete(key);
        }
    }

    console.log("Active terrain chunks:", terrainChunks.size);
}

function CreateChunkRocks(chunkX, chunkZ) {

    const chunkRocks = [];

    // Give every chunk its own repeatable random sequence.
    let seed = (
        Math.imul(chunkX, 73856093) ^
        Math.imul(chunkZ, 19349663) ^
        12345
    ) >>> 0;

    function random() {
        seed = (
            Math.imul(1664525, seed) + 1013904223
        ) >>> 0;

        return seed / 4294967296;
    }

    // Fifteen rocks in this chunk.
    for (let i = 0; i < 6; i++) {

        const x = chunkX * 800 - 400 + random() * 800;
        const z = chunkZ * 800 - 400 + random() * 800;

        const scale = 0.65 + random() * 1.25;
        const rock = generateRock(x, z, scale);   

        chunkRocks.push({
            vertices: generateBuffers(
                rock.vertices, "ARRAY_BUFFER"),

            normals: generateBuffers(
                rock.normals, "ARRAY_BUFFER"),

            texture: generateBuffers(
                rock.textureCoordinates, "ARRAY_BUFFER"),

            indices: generateBuffers(
                rock.indices, "ELEMENT_ARRAY_BUFFER"),

            count: rock.indices.length
        });
    }

    return chunkRocks;
}

function CreateTerrainChunk(chunkX, chunkZ) {

    const terrain = generateTerrain(chunkX, chunkZ);

    return {
        vertices: generateBuffers(
            terrain.vertices, "ARRAY_BUFFER"),

        indices: generateBuffers(
            terrain.indices, "ELEMENT_ARRAY_BUFFER"),

        texture: generateBuffers(
            terrain.textureCoordinates, "ARRAY_BUFFER"),

        normals: generateBuffers(
            terrain.normals, "ARRAY_BUFFER"),

        count: terrain.indices.length,

        // Every chunk owns its own rocks!
        rocks: CreateChunkRocks(chunkX, chunkZ),
        trees: CreateChunkTrees(chunkX, chunkZ),
        cottages: CreateChunkCottages(chunkX, chunkZ),
        people: CreateChunkPeople(chunkX, chunkZ)
    };
}

function UpdatePerson(person, dt) {


    // Find the player's position.
    const playerX = -x_location;
    const playerZ = -z_location;

    const playerDX = playerX - person.x;
    const playerDZ = playerZ - person.z;

    const playerDistance = Math.hypot(
        playerDX, playerDZ
    );

    // Have we noticed the player?
    if (playerDistance < 100) {

        // Calculate the direction towards the player.
        const targetAngle =
            Math.atan2(playerDX, playerDZ) * 180 / Math.PI;

        // Find the shortest rotation towards the player.
        const difference =
            ((targetAngle - person.angle + 540) % 360) - 180;

        // Turn gently rather than snapping around.
        person.angle += difference * Math.min(1, dt * 3);

        // Stop walking while the player is nearby.
        return;
    }


    let dx = person.targetX - person.x;
    let dz = person.targetZ - person.z;

    let distance = Math.hypot(dx, dz);

    // Reached our destination: choose somewhere new.
    if (distance < 1) {

        const direction = Math.random() * Math.PI * 2;
        const radius = 30 + Math.random() * 120;

        //const radius = 20 + Math.random() * 40;

        person.targetX =
            person.homeX + Math.sin(direction) * radius;

        person.targetZ =
            person.homeZ + Math.cos(direction) * radius;

        // Keep the person safely inside their home chunk.
        const minX = person.chunkX * 800 - 370;
        const maxX = person.chunkX * 800 + 370;

        const minZ = person.chunkZ * 800 - 370;
        const maxZ = person.chunkZ * 800 + 370;

        person.targetX = Math.max(
            minX, Math.min(maxX, person.targetX)
        );

        person.targetZ = Math.max(
            minZ, Math.min(maxZ, person.targetZ)
        );

        dx = person.targetX - person.x;
        dz = person.targetZ - person.z;

        distance = Math.hypot(dx, dz);
    }

    if (distance < 0.001) {
        return;
    }

    // Face the direction of travel.
    person.angle =
        Math.atan2(dx, dz) * 180 / Math.PI;

    // Wander towards the destination.
    const step = Math.min(person.speed * dt, distance);

    person.x += dx / distance * step;
    person.z += dz / distance * step;
}

function DrawPerson(person) {

    movePushMatrix();

    const ground = terrainHeight(person.x, person.z);

    // Move the little person into the world.
    moveTranslate([
        person.x,
        ground,
        person.z
    ]);

    // Turn to face the direction of travel.
    moveRotate(person.angle, [0, 1, 0]);

    const palette =
        personCloakPalettes[person.colourIndex];

    for (const [name, mesh] of Object.entries(person.meshes)) {

        let texture = personTextures[name];

        if (name === "cloak" || name === "hood") {
            texture = palette[name];
        }

        DrawTreePart(mesh, texture);
    }

    movePopMatrix();
}


function CreateChunkPeople(chunkX, chunkZ) {

    const people = [];

    // Unique, repeatable randomness for each chunk.
    let seed = (
        Math.imul(chunkX, 628939) ^
        Math.imul(chunkZ, 927733) ^
        43210
    ) >>> 0;

    function random() {
        seed = (
            Math.imul(1664525, seed) + 1013904223
        ) >>> 0;

        return seed / 4294967296;
    }

    // Only 25% of chunks contain inhabitants.
    if (random() >= 0.4) {
        return people;
    }

    // Usually one person, occasionally two.
    const count = random() < 0.15 ? 2 : 1;

    for (let i = 0; i < count; i++) {

        const x = chunkX * 800 - 300 + random() * 600;
        const z = chunkZ * 800 - 300 + random() * 600;
        const geometry = generatePerson();

        const resident = {

            meshes: {},
            colourIndex: Math.floor(random() * 4),

            homeX: x,
            homeZ: z,

            x: x,
            z: z,

            targetX: x,
            targetZ: z,

            angle: 0,
            speed: 20 + ((seed >>> 8) % 10),

            chunkX: chunkX,
            chunkZ: chunkZ
        };


        for (const [name, mesh] of Object.entries(geometry)) {
            resident.meshes[name] = makeTreeBuffers(mesh);
        }

        people.push(resident);
    }

    return people;
}

function makeColourTexture(r,g,b) {

    const texture = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D,texture);

    gl.texImage2D(
        gl.TEXTURE_2D,0,gl.RGBA,
        1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,
        new Uint8Array([r,g,b,255])
    );

    gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.LINEAR
    );

    return texture;
}

function UpdateCameraChunk() {

    // Our engine stores inverse camera translations.
    const cameraX = -x_location;
    const cameraZ = -z_location;

    // Which 800-unit chunk are we standing in?
    const chunkX = Math.floor((cameraX + 400) / 800);
    const chunkZ = Math.floor((cameraZ + 400) / 800);

    // Only report when we enter a different chunk.
    if (chunkX !== currentChunkX ||
        chunkZ !== currentChunkZ) {

        currentChunkX = chunkX;
        currentChunkZ = chunkZ;

        UpdateTerrainChunks();

        console.log(
            "Entered terrain chunk:",
            chunkX, chunkZ
        );
    }
}

function DrawTreePart(mesh, texture) {

    movePushMatrix();

    gl.bindBuffer(gl.ARRAY_BUFFER,mesh.texture);
    gl.vertexAttribPointer(
        textureCoordAttribute,2,gl.FLOAT,false,0,0
    );

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.uniform1i(
        gl.getUniformLocation(shaderProgram,"uSampler"),0
    );

    gl.bindBuffer(gl.ARRAY_BUFFER,mesh.normals);
    gl.vertexAttribPointer(
        vertexNormalAttribute,3,gl.FLOAT,false,0,0
    );

    gl.bindBuffer(gl.ARRAY_BUFFER,mesh.vertices);
    gl.vertexAttribPointer(
        vertexPositionAttribute,3,gl.FLOAT,false,0,0
    );

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,mesh.indices);

    setMatrixUniforms();

    gl.drawElements(
        gl.TRIANGLES,
        mesh.count,
        gl.UNSIGNED_SHORT,
        0
    );

    movePopMatrix();
}

let lastFrameCheck = performance.now();

function FrameMonitor() {

  console.log("Gameplay updates:", gameplayUpdates);

  gameplayUpdates = 0;

  const now = performance.now();

  const elapsed = (now - lastFrameCheck) / 1000;

  fps = Math.round(frames / elapsed);

  frames = 0;

  lastFrameCheck = now;

  UpdateStats();
}

function generatePerson(x, z) {

    const scale = 0.65;

    function mesh() {
        return {
            vertices: [],
            normals: [],
            textureCoordinates: [],
            indices: []
        };
    }

    // Just five coloured parts!
    const person = {
        cloak: mesh(),
        hood: mesh(),
        face: mesh(),
        eyes: mesh(),
        boots: mesh()
    };

    function P(a, b, c) {
      return [
          a * scale,
          b * scale,
          c * scale
      ];
    }

    function triangle(m, a, b, c) {

        const ux = b[0] - a[0];
        const uy = b[1] - a[1];
        const uz = b[2] - a[2];

        const vx = c[0] - a[0];
        const vy = c[1] - a[1];
        const vz = c[2] - a[2];

        const nx = uy*vz - uz*vy;
        const ny = uz*vx - ux*vz;
        const nz = ux*vy - uy*vx;

        const length = Math.hypot(nx, ny, nz);
        const first = m.vertices.length / 3;

        for (const p of [a, b, c]) {
            m.vertices.push(...p);
            m.normals.push(nx/length, ny/length, nz/length);
            m.textureCoordinates.push(0, 0);
        }

        m.indices.push(first, first+1, first+2);
    }

    function quad(m, a, b, c, d) {
        triangle(m, a, b, c);
        triangle(m, a, c, d);
    }

    function box(m, x1, x2, y1, y2, z1, z2) {

        const l = x1, r = x2;
        const b = y1, t = y2;
        const back = z1, front = z2;

        quad(m, P(l,b,front), P(r,b,front),
                P(r,t,front), P(l,t,front));

        quad(m, P(r,b,back), P(l,b,back),
                P(l,t,back), P(r,t,back));

        quad(m, P(l,b,back), P(l,b,front),
                P(l,t,front), P(l,t,back));

        quad(m, P(r,b,front), P(r,b,back),
                P(r,t,back), P(r,t,front));

        quad(m, P(l,t,front), P(r,t,front),
                P(r,t,back), P(l,t,back));

        quad(m, P(l,b,back), P(r,b,back),
                P(r,b,front), P(l,b,front));
    }

    // SHORT LITTLE BOOTS
    box(person.boots, -7, -1, 0, 6, -4, 10);
    box(person.boots, 1, 7, 0, 6, -4, 10);

    // FLARED CLOAK: narrow shoulders, wider hem.
    // Front
    quad(person.cloak,
        P(-14,4,8), P(14,4,8),
        P(9,25,5), P(-9,25,5));

    // Back
    quad(person.cloak,
        P(14,4,-9), P(-14,4,-9),
        P(-9,25,-6), P(9,25,-6));

    // Left side
    quad(person.cloak,
        P(-14,4,-9), P(-14,4,8),
        P(-9,25,5), P(-9,25,-6));

    // Right side
    quad(person.cloak,
        P(14,4,8), P(14,4,-9),
        P(9,25,-6), P(9,25,5));

    // Top
    quad(person.cloak,
        P(-9,25,5), P(9,25,5),
        P(9,25,-6), P(-9,25,-6));

    // DARK FACE INSIDE THE HOOD.
    // No skin, nose, mouth or ears.
    box(person.face, -7, 7, 25, 39, -6, 7.5);

    // HOOD: solid rear and narrow side panels.
    // The open front frames the dark face.
    box(person.hood, -10, -7, 25, 40, -9, 9);
    box(person.hood, 7, 10, 25, 40, -9, 9);
    box(person.hood, -10, 10, 25, 40, -9, -6);

    // A simple pointed roof over the face.
    quad(person.hood,
        P(-10,40,9), P(0,44,9),
        P(0,44,-9), P(-10,40,-9));

    quad(person.hood,
        P(0,44,9), P(10,40,9),
        P(10,40,-9), P(0,44,-9));

    // Front triangular peak.
    triangle(person.hood,
        P(-10,40,9),
        P(10,40,9),
        P(0,44,9));

    // TWO LITTLE RED EYES.
    // Slightly forward of the dark face.
    box(person.eyes, -5, -3, 31, 33, 7.5, 8.1);
    box(person.eyes, 3, 5, 31, 33, 7.5, 8.1);

    return person;
}

function DrawTree(tree) {

    DrawTreePart(tree.trunk, treeTrunkTexture);
    DrawTreePart(tree.crown, treeCrownTexture);
}

function DrawCottage(house) {

    DrawTreePart(house.walls, cottageTextures.walls);
    DrawTreePart(house.roof, cottageTextures.roof);
    DrawTreePart(house.door, cottageTextures.door);
    DrawTreePart(house.windows, cottageTextures.windows);
}

function makeTreeBuffers(mesh) {
    return {
        vertices: generateBuffers(
            mesh.vertices, "ARRAY_BUFFER"),

        normals: generateBuffers(
            mesh.normals, "ARRAY_BUFFER"),

        texture: generateBuffers(
            mesh.textureCoordinates, "ARRAY_BUFFER"),

        indices: generateBuffers(
            mesh.indices, "ELEMENT_ARRAY_BUFFER"),

        count: mesh.indices.length
    };
}


function ResizeCanvas() {

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    gl.viewport(0, 0, canvas.width, canvas.height);

    const perspectiveMatrix = createPerspective(
        45,
        canvas.width / canvas.height,
        0.1,
        2000.0
    );

    const pUniform = gl.getUniformLocation(
        shaderProgram, "uPMatrix"
    );

    gl.uniformMatrix4fv(
        pUniform,
        false,
        new Float32Array(perspectiveMatrix)
    );
}


function start() {

  canvas = document.getElementById("glcanvas");
  canvas.width = window.innerWidth - 10;
  canvas.height = window.innerHeight - 10;

  initWebGL(canvas);

  if (gl) {
    gl.clearColor(0.76, 0.87, 0.97, 1.0);
    gl.clearDepth(1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    initShaders();

    treeTrunkTexture = makeColourTexture(115, 75, 42);
    treeCrownTexture = makeColourTexture(66, 145, 62);

    cottageTextures = {
        walls: makeColourTexture(220, 205, 165),
        roof: makeColourTexture(155, 75, 48),
        door: makeColourTexture(95, 60, 35),
        windows: makeColourTexture(110, 170, 185)
    };

    personTextures = {
        face: makeColourTexture(24, 19, 25),
        eyes: makeColourTexture(255, 65, 35),
        boots: makeColourTexture(90, 60, 40)
    };

    personCloakPalettes = [
        {
            cloak: makeColourTexture(185, 55, 75),
            hood: makeColourTexture(205, 70, 85)
        },
        {
            cloak: makeColourTexture(55, 85, 155),
            hood: makeColourTexture(70, 105, 180)
        },
        {
            cloak: makeColourTexture(65, 125, 75),
            hood: makeColourTexture(85, 145, 95)
        },
        {
            cloak: makeColourTexture(115, 75, 145),
            hood: makeColourTexture(140, 95, 170)
        }
    ];

    terrainTexture = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, terrainTexture);

    gl.texImage2D(
              gl.TEXTURE_2D, 0, gl.RGBA,
              1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
              new Uint8Array([90, 160, 65, 255])
    );

    gl.texParameteri(
              gl.TEXTURE_2D,
              gl.TEXTURE_MIN_FILTER,
              gl.LINEAR
    );

    // A single grey pixel for our rock colour.
    rockTexture = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, rockTexture);

    gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGBA,
          1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([145, 148, 139, 255])
    );

    gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR
    );

    ResizeCanvas();
    InitTouchControls();

    window.addEventListener("resize", ResizeCanvas);

    let lastFrameTime = performance.now();

    function renderFrame() {

        const now = performance.now();

        const dt = Math.min(
            (now - lastFrameTime) / 1000,
            0.05
        );

        lastFrameTime = now;

        GameplayLoop(dt);

        GraphicsLoop();

        requestAnimationFrame(renderFrame);
    }

    requestAnimationFrame(renderFrame);

    setInterval(function() { FrameMonitor() }, 1000);
  }
}

function GraphicsLoop() {

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      UpdateCameraChunk();

      const now = performance.now();

      const dt = Math.min(
          (now - lastPeopleUpdate) / 1000,
          0.05
      );

      lastPeopleUpdate = now;

      loadIdentity();

      moveRotate(0, [1, 0, 0]);
      moveRotate(y_camera_angle, [1, 0, 0]);
      moveRotate(camera_angle, [0, 1, 0]);

      moveTranslate([x_location, y_location, z_location]);

      const eyeHeight = 30;

      y_location = -(
        terrainHeight(-x_location, -z_location) + eyeHeight
      );

      gl.uniform1f(
        gl.getUniformLocation(shaderProgram, "uTerrainPatch"),
        1.0
      );

      for (const chunk of terrainChunks.values()) {
        DrawTerrain(chunk);
      }

      gl.uniform1f(
      gl.getUniformLocation(shaderProgram, "uTerrainPatch"),
      0.0
      );

      for (const chunk of terrainChunks.values()) {
          for (const rock of chunk.rocks) {
              DrawRock(rock);
          }
      }

      for (const chunk of terrainChunks.values()) {
          for (const tree of chunk.trees) {
              DrawTree(tree);
          }
      }

      for (const chunk of terrainChunks.values()) {
          for (const house of chunk.cottages) {
              DrawCottage(house);
          }
      }

      for (const chunk of terrainChunks.values()) {
        for (const person of chunk.people) {

          UpdatePerson(person, dt);
          DrawPerson(person);
        }
      }

    frames++;
}

function GameplayLoop(dt) {

    gameplayUpdates++;

    ControlPlayerMovement(dt);
    ControlTouchMovement(dt);
}

function checkKeyUnPressed(e) {
  
  // Note the keyCodes are ASCII codes
  if (e.keyCode == "37") {
    rotate_direction = 0;
    player_rotation_speed = 0;
  }
  if (e.keyCode == "39") {
    rotate_direction = 0;
    player_rotation_speed = 0;
  }
  if (e.keyCode == "68") {
    rotate_direction = 0;
    player_rotation_speed = 0;
  }
  if (e.keyCode == "65") {
    rotate_direction = 0;
    player_rotation_speed = 0;
  }
  if (e.keyCode == "40") {
    movement_direction = 0;
  }
  if (e.keyCode == "38") {
    movement_direction = 0;
  }
  if (e.keyCode == "87") {
    movement_direction = 0;
  }
  if (e.keyCode == "83") {
    movement_direction = 0;
  } 
  if (e.keyCode == "41") {
    movement_direction = 0;
  }
  if (e.keyCode == "44") {
    movement_direction = 0;
  }
  if (e.keyCode == "188") {
    movement_direction = 0;
  }
  if (e.keyCode == "190") {
    movement_direction = 0;
  }
  if (e.keyCode == "79") {
    movement_direction = 0;
  }
  if (e.keyCode == "76") {
    movement_direction = 0;
  }
  if (e.keyCode == "37") {
    rotate_direction = 0;
    player_rotation_speed = 0;
  }
  if (e.keyCode == "39") {
    rotate_direction = 0;
    player_rotation_speed = 0;
  }
  if (e.keyCode == "65") {
    rotate_direction = 0;
    player_rotation_speed = 0;
  }
  if (e.keyCode == "68") {
    rotate_direction = 0;
    player_rotation_speed = 0;
  }
} 
  
function checkKeyPressed(e) {
  
  if (e.keyCode == "37") {
    rotate_direction = 1;
  }
  if (e.keyCode == "65") {
    rotate_direction = 1;
  }
  if (e.keyCode == "39") {
    rotate_direction = 2;
  }
  if (e.keyCode == "68") {
    rotate_direction = 2;
  }  
  if (e.keyCode == "87") {
    movement_direction = 1;
  }
  if (e.keyCode == "38") {
    movement_direction = 1;
  }
  if (e.keyCode == "40") {
    movement_direction = 2;
  }
  if (e.keyCode == "83") {
    movement_direction = 2;
  }
}

function ControlPlayerMovement(dt) {

    const timeScale = dt * 240;

    // Smooth camera rotation.
    const minTurnSpeed = 25;
    const maxTurnSpeed = 120;
    const turnAcceleration = 160;

    if (rotate_direction === 1 || rotate_direction === 2) {

        player_rotation_speed = Math.min(
            maxTurnSpeed,
            Math.max(minTurnSpeed, player_rotation_speed)
                + turnAcceleration * dt
        );

        if (rotate_direction === 1) {
            camera_angle -= player_rotation_speed * dt;
        }
        else {
            camera_angle += player_rotation_speed * dt;
        }

        camera_angle = (camera_angle % 360 + 360) % 360;
    }
    else {
        player_rotation_speed = 0;
    }

    if (movement_direction == 2) {
    
      let camera_angle_in_radians = camera_angle * 0.0174532925;
      let x_probable = x_location;
      let z_probable = z_location;
    
      x_probable += Math.sin( camera_angle_in_radians ) * (player_speed+acceleration) * timeScale;
      z_probable -= Math.cos( camera_angle_in_radians ) * (player_speed+acceleration) * timeScale;
    
      //if (CollisionDetection(x_probable*-1,(y_location+20)*-1,z_location*-1) == false)
        x_location = x_probable;
            
      //if (CollisionDetection(x_location*-1,(y_location+20)*-1,z_probable*-1) == false)
        z_location = z_probable;
    }
    
    if (movement_direction == 1) {
    
      let camera_angle_in_radians = camera_angle * 0.0174532925;
      let x_probable = x_location;
      let z_probable = z_location;

      x_probable -= Math.sin( camera_angle_in_radians ) * (player_speed+acceleration) * timeScale;
      z_probable += Math.cos( camera_angle_in_radians ) * (player_speed+acceleration) * timeScale;
    
      //if (CollisionDetection(x_probable*-1,(y_location+20)*-1,z_location*-1) == false)
        x_location = x_probable;
            
      //if (CollisionDetection(x_location*-1,(y_location+20)*-1,z_probable*-1) == false)
        z_location = z_probable;
    } 

    if (movement_direction == 3) { // Move left
    
      let camera_angle_in_radians = (camera_angle-90) * 0.0174532925;
      let x_probable = x_location;
      let z_probable = z_location;
    
      x_probable -= Math.sin( camera_angle_in_radians ) * (player_speed+acceleration) * timeScale;
      z_probable += Math.cos( camera_angle_in_radians ) * (player_speed+acceleration) * timeScale;
    
      //if (CollisionDetection(x_probable*-1,(y_location+20)*-1,z_location*-1) == false )
        x_location = x_probable;
            
      //if (CollisionDetection(x_location*-1,(y_location+20)*-1,z_probable*-1) == false )
        z_location = z_probable;
    } 

    if (movement_direction == 4) { // move right
    
      let camera_angle_in_radians = (camera_angle + 90) * 0.0174532925;
      let x_probable = x_location;
      let z_probable = z_location;
    
      x_probable -= Math.sin( camera_angle_in_radians ) * (player_speed+acceleration) * timeScale;
      z_probable += Math.cos( camera_angle_in_radians ) * (player_speed+acceleration) * timeScale;
    
      //if (CollisionDetection(x_probable*-1,(y_location+20)*-1,z_location*-1) == false )
        x_location = x_probable;
            
      //if (CollisionDetection(x_location*-1,(y_location+20)*-1,z_probable*-1) == false )
        z_location = z_probable;
    } 
}

function DrawRock(rock) {

    movePushMatrix();

    gl.bindBuffer(gl.ARRAY_BUFFER, rock.texture);
    gl.vertexAttribPointer(
        textureCoordAttribute, 2, gl.FLOAT, false, 0, 0
    );

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rockTexture);

    gl.uniform1i(
        gl.getUniformLocation(shaderProgram, "uSampler"), 0
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, rock.normals);
    gl.vertexAttribPointer(
        vertexNormalAttribute, 3, gl.FLOAT, false, 0, 0
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, rock.vertices);
    gl.vertexAttribPointer(
        vertexPositionAttribute, 3, gl.FLOAT, false, 0, 0
    );

    gl.bindBuffer(
        gl.ELEMENT_ARRAY_BUFFER,
        rock.indices
    );

    setMatrixUniforms();

    gl.drawElements(
        gl.TRIANGLES,
        rock.count,
        gl.UNSIGNED_SHORT,
        0
    );

    movePopMatrix();
}

function DrawTerrain(chunk) {

    movePushMatrix();

    // Texture coordinates
    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.texture);
    gl.vertexAttribPointer(textureCoordAttribute, 2, gl.FLOAT, false, 0, 0);

    // Green terrain texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, terrainTexture);
    gl.uniform1i(
        gl.getUniformLocation(shaderProgram, "uSampler"), 0
    );

    // Tell WebGL which way each terrain vertex faces.
    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.normals);

    gl.vertexAttribPointer(
        vertexNormalAttribute,
        3,
        gl.FLOAT,
        false,
        0,
        0
    );

    // Terrain vertices
    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.vertices);
    gl.vertexAttribPointer(vertexPositionAttribute, 3, gl.FLOAT, false, 0, 0);

    // Terrain triangles
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, chunk.indices);

    setMatrixUniforms();

    const time = performance.now() * 0.0001;
    const sunX = Math.cos(time);
    const sunY = Math.sin(time);
    const sunZ = 0.5;

    gl.uniform3f(
      gl.getUniformLocation(shaderProgram, "uSunDirection"),
      sunX, sunY, sunZ
    );

    gl.drawElements(
        gl.TRIANGLES,
        chunk.count,
        gl.UNSIGNED_SHORT,
        0
    );

    if (!window.terrainChecked) {

    window.terrainChecked = true;

    console.log("DrawTerrain was called");
    console.log("Triangles requested:", chunk.count / 3);
    console.log("WebGL error:", gl.getError());
    console.log("Terrain texture:", gl.isTexture(terrainTexture));

  }

  movePopMatrix();
}

function multiplyMatrices(a, b) {

  const result = Array(4).fill().map(() => Array(4).fill(0));

  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) {
        result[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return result;
}

function translateMatrix(vector,current_location_metrix) {

  let new_location_matrix = [[1,0,0,vector[0],],
                             [0,1,0,vector[1],],
                             [0,0,1,vector[2],],
                             [0,0,0,1]];

  return multiplyMatrices(current_location_metrix, new_location_matrix );
}

function rotateMatrix(angle, axis, current_location_metrix) {

  let length = Math.hypot(axis[0], axis[1], axis[2]);
  let x = axis[0] / length;
  let y = axis[1] / length;
  let z = axis[2] / length;

  let c = Math.cos(angle);
  let s = Math.sin(angle);
  let t = 1 - c;

  let rotate_matrix = [
    [t*x*x + c,     t*x*y - z*s,   t*x*z + y*s,   0],
    [t*x*y + z*s,   t*y*y + c,     t*y*z - x*s,   0],
    [t*x*z - y*s,   t*y*z + x*s,   t*z*z + c,     0],
    [0,             0,             0,             1]
  ];

  return multiplyMatrices(current_location_metrix, rotate_matrix );
}

function flattenMatrix(multi_dimentional_matrix) {
    let result = [];
    for (let j = 0; j < multi_dimentional_matrix[0].length; j++)
        for (let i = 0; i < multi_dimentional_matrix.length; i++)
            result.push(multi_dimentional_matrix[i][j]);
    return result;
}

function createPerspective(fovy, aspect, znear, zfar) {
    let ymax = znear * Math.tan(fovy * Math.PI / 360.0);
    let ymin = -ymax;
    let xmin = ymin * aspect;
    let xmax = ymax * aspect;
    let X = 2*znear/(xmax-xmin);
    let Y = 2*znear/(ymax-ymin);
    let A = (xmax+xmin)/(xmax-xmin);
    let B = (ymax+ymin)/(ymax-ymin);
    let C = -(zfar+znear)/(zfar-znear);
    let D = -1;

    let perspective_matrix = flattenMatrix([[X, 0, A, 0],
                              [0, Y, B, 0],
                              [0, 0, C, D],
                              [0, 0, -1, 0]]);

    return perspective_matrix;
}

function loadIdentity() {

  movementMatrix =  [[1,0,0,0,],
                  [0,1,0,0,],
                  [0,0,1,0,],
                  [0,0,0,1]
                 ];
}

function moveTranslate(v) {
  movementMatrix = translateMatrix(v,movementMatrix);
}

function setMatrixUniforms() {
  let mvUniform = gl.getUniformLocation(shaderProgram, "uMVMatrix");
  gl.uniformMatrix4fv(mvUniform, false, new Float32Array(flattenMatrix(movementMatrix)));
}

function movePushMatrix() {
    let duplicate = movementMatrix;
    matrixStack.push(duplicate);
}

function movePopMatrix() {
  if (!matrixStack.length) {
    throw("Can't pop from an empty matrix stack.");
  }
  movementMatrix = matrixStack.pop();
}

function moveRotate(angle, v) {

  let inRadians = angle * Math.PI / 180.0;
  movementMatrix = rotateMatrix(inRadians,v,movementMatrix);
}

function regionalNoise(x, z, scale) {

    const gx = x / scale;
    const gz = z / scale;

    const ix = Math.floor(gx);
    const iz = Math.floor(gz);

    let fx = gx - ix;
    let fz = gz - iz;

    // Smooth interpolation between grid points.
    fx = fx * fx * (3 - 2 * fx);
    fz = fz * fz * (3 - 2 * fz);

    function random(a, b) {
        let h = Math.imul(a, 374761393) +
                Math.imul(b, 668265263);

        h = Math.imul(h ^ (h >>> 13), 1274126177);

        return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    }

    const a = random(ix,     iz);
    const b = random(ix + 1, iz);
    const c = random(ix,     iz + 1);
    const d = random(ix + 1, iz + 1);

    const top = a + (b - a) * fx;
    const bottom = c + (d - c) * fx;

    return top + (bottom - top) * fz;
}

function terrainHeight(worldX, worldZ) {

    // Broad regions of different landscape character.
    const region = regionalNoise(worldX, worldZ, 3800);

    // Convert the regional signal into smooth hilliness.
    let t = (region - 0.28) / 0.44;
    t = Math.max(0, Math.min(1, t));

    const blend = t * t * (3 - 2 * t);

    // Large and medium rolling hills.
    const hills =
        100 * Math.sin(worldX * 0.003) *
              Math.cos(worldZ * 0.003) +

          25 * Math.sin(worldX * 0.012) *
              Math.cos(worldZ * 0.009) +

          5 * Math.sin(worldX * 0.04) *
              Math.cos(worldZ * 0.035);

    const ripples =
    3 * Math.sin(worldX * 0.025) *
        Math.cos(worldZ * 0.022) +

    2 * Math.sin(worldX * 0.035 + worldZ * 0.015);

    const hillStrength = 0.18 + 0.87 * blend;

    const rippleStrength = 0.50 - 0.25 * blend;

    const highlands = 100 * blend;

    // Gentle folds across the basin.
    const basinDetail =
    2.5 * Math.sin(worldX * 0.018) *
          Math.cos(worldZ * 0.021) +

    1.5 * Math.sin(worldX * 0.031 +
                   worldZ * 0.014);

    return hills * hillStrength + ripples * rippleStrength + highlands;
}

function generateTree(x, z) {

    const ground = terrainHeight(x, z);

    // A helper to build triangle meshes.
    function createMesh() {
        return {
            vertices: [],
            normals: [],
            textureCoordinates: [],
            indices: []
        };
    }

    const trunk = createMesh();
    const crown = createMesh();

    function addTriangle(mesh, a, b, c) {

        const u = [
            b[0] - a[0],
            b[1] - a[1],
            b[2] - a[2]
        ];

        const v = [
            c[0] - a[0],
            c[1] - a[1],
            c[2] - a[2]
        ];

        const nx = u[1]*v[2] - u[2]*v[1];
        const ny = u[2]*v[0] - u[0]*v[2];
        const nz = u[0]*v[1] - u[1]*v[0];

        const length = Math.hypot(nx, ny, nz);

        const first = mesh.vertices.length / 3;

        for (const p of [a, b, c]) {
            mesh.vertices.push(...p);
            mesh.normals.push(
                nx / length,
                ny / length,
                nz / length
            );
            mesh.textureCoordinates.push(0, 0);
        }

        mesh.indices.push(first, first+1, first+2);
    }

    // Brown rectangular trunk.
    const w = 3;
    const bottom = ground - 3;
    const top = ground + 24;

    const a = [x-w, bottom, z-w];
    const b = [x+w, bottom, z-w];
    const c = [x+w, bottom, z+w];
    const d = [x-w, bottom, z+w];

    const e = [x-w, top, z-w];
    const f = [x+w, top, z-w];
    const g = [x+w, top, z+w];
    const h = [x-w, top, z+w];

    // Four sides of the trunk.
    for (const face of [
        [a,b,f,e],
        [b,c,g,f],
        [c,d,h,g],
        [d,a,e,h]
    ]) {
        addTriangle(trunk,face[0],face[1],face[2]);
        addTriangle(trunk,face[0],face[2],face[3]);
    }

    // Pine tree: three overlapping layers of foliage.
    const sides = 9;

    const layers = [
        {base: 18, top: 42, radius: 19},
        {base: 30, top: 53, radius: 14},
        {base: 43, top: 64, radius: 9}
    ];

    for (const layer of layers) {

        const ring = [];

        for (let i = 0; i < sides; i++) {

            const angle = i * Math.PI * 2 / sides;

            // Slight irregularity avoids perfect cones.
            const radius = layer.radius *
                (1 + 0.10 * Math.sin(i * 2.7));
                

            ring.push([
                x + Math.cos(angle) * radius,
                ground + layer.base +
                    1.5 * Math.sin(i * 1.9),
                z + Math.sin(angle) * radius
            ]);
        }

        const peak = [
            x + 1,
            ground + layer.top,
            z - 1
        ];

        const underside = [
            x,
            ground + layer.base - 2,
            z
        ];

        for (let i = 0; i < sides; i++) {

            const next = (i + 1) % sides;

            addTriangle(
                crown,
                ring[i],
                peak,
                ring[next]
            );

            addTriangle(
                crown,
                ring[next],
                underside,
                ring[i]
            );
        }
    }
    return {trunk,crown};
}

function generateCottage(x, z) {

    const ground = terrainHeight(x, z);

    function mesh() {
        return {
            vertices: [],
            normals: [],
            textureCoordinates: [],
            indices: []
        };
    }

    const walls = mesh();
    const roof = mesh();
    const door = mesh();
    const windows = mesh();

    function triangle(m, a, b, c) {

        const u = a.map((v, i) => b[i] - v);
        const v = a.map((n, i) => c[i] - n);

        const nx = u[1]*v[2] - u[2]*v[1];
        const ny = u[2]*v[0] - u[0]*v[2];
        const nz = u[0]*v[1] - u[1]*v[0];

        const length = Math.hypot(nx, ny, nz);
        const first = m.vertices.length / 3;

        for (const p of [a, b, c]) {
            m.vertices.push(...p);
            m.normals.push(
                nx / length, ny / length, nz / length
            );
            m.textureCoordinates.push(0, 0);
        }

        m.indices.push(first, first+1, first+2);
    }

    function quad(m, a, b, c, d) {
        triangle(m, a, b, c);
        triangle(m, a, c, d);
    }

    // Cottage dimensions.
    const left = x - 40;
    const right = x + 40;
    const back = z - 32;
    const front = z + 32;

    const bottom = ground - 5;
    const eaves = ground + 48;
    const ridge = ground + 78;

    // Four rectangular walls.
    quad(walls,
        [left,bottom,front], [right,bottom,front],
        [right,eaves,front], [left,eaves,front]);

    quad(walls,
        [right,bottom,back], [left,bottom,back],
        [left,eaves,back], [right,eaves,back]);

    quad(walls,
        [left,bottom,back], [left,bottom,front],
        [left,eaves,front], [left,eaves,back]);

    quad(walls,
        [right,bottom,front], [right,bottom,back],
        [right,eaves,back], [right,eaves,front]);

    // Triangular gable walls.
    triangle(walls,
        [left,eaves,front],
        [right,eaves,front],
        [x,ridge,front]);

    triangle(walls,
        [right,eaves,back],
        [left,eaves,back],
        [x,ridge,back]);

    // Two sloping roof panels with overhangs.
    const roofFront = front + 5;
    const roofBack = back - 5;

    quad(roof,
        [left-5,eaves,roofFront],
        [x,ridge+3,roofFront],
        [x,ridge+3,roofBack],
        [left-5,eaves,roofBack]);

    quad(roof,
        [x,ridge+3,roofFront],
        [right+5,eaves,roofFront],
        [right+5,eaves,roofBack],
        [x,ridge+3,roofBack]);

    // Wooden front door.
    quad(door,
        [x-10,bottom,front+1],
        [x+10,bottom,front+1],
        [x+10,ground+30,front+1],
        [x-10,ground+30,front+1]);

    // Two little square windows.
    for (const wx of [x-26, x+26]) {

        quad(windows,
            [wx-7,ground+23,front+1.5],
            [wx+7,ground+23,front+1.5],
            [wx+7,ground+37,front+1.5],
            [wx-7,ground+37,front+1.5]);
    }

    return {walls, roof, door, windows};
}

function generateRock(x, z, scale = 1) {

    const vertices = [];
    const normals = [];
    const indices = [];
    const textureCoordinates = [];

    const ground = terrainHeight(x, z);

    // Seven uneven corners.
    const radii = [18, 15, 20, 16, 19, 14, 17];
    const sides = radii.length;

    const bottom = [];
    const shoulder = [];

    for (let i = 0; i < sides; i++) {

        const angle = i * Math.PI * 2 / sides;

        const dx = Math.cos(angle);
        const dz = Math.sin(angle);

        const radius = radii[i] * scale;

        bottom.push([
            x + dx * radius,
            ground - 4 * scale,
            z + dz * radius
        ]);

        shoulder.push([
            x + dx * radius * 0.82,
            ground + (7 + (i % 3)) * scale,
            z + dz * radius * 0.82
        ]);
    }

    // A low, slightly off-centre top.
    const peak = [
        x + 2 * scale,
        ground + 11 * scale,
        z - 3 * scale
    ];


    // Add one triangular face with its own normal.
    function addTriangle(a, b, c) {

        const ux = b[0] - a[0];
        const uy = b[1] - a[1];
        const uz = b[2] - a[2];

        const vx = c[0] - a[0];
        const vy = c[1] - a[1];
        const vz = c[2] - a[2];

        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;

        const length = Math.hypot(nx, ny, nz);

        nx /= length;
        ny /= length;
        nz /= length;

        const first = vertices.length / 3;

        for (const point of [a, b, c]) {
            vertices.push(...point);
            normals.push(nx, ny, nz);
            textureCoordinates.push(0, 0);
        }

        indices.push(first, first + 1, first + 2);
    }

    // Seven sides, each divided into two triangles.
    for (let i = 0; i < sides; i++) {

        const next = (i + 1) % sides;

        addTriangle(
            bottom[i], shoulder[i], bottom[next]
        );

        addTriangle(
            bottom[next], shoulder[i], shoulder[next]
        );

        // Sloping upper faces.
        addTriangle(
            shoulder[i], peak, shoulder[next]
        );
    }

    return { vertices, normals, indices, textureCoordinates };
}


function grassNoise(x, z, scale) {

    const gx = x / scale;
    const gz = z / scale;

    const ix = Math.floor(gx);
    const iz = Math.floor(gz);

    let fx = gx - ix;
    let fz = gz - iz;

    // Smooth the transitions.
    fx = fx * fx * (3 - 2 * fx);
    fz = fz * fz * (3 - 2 * fz);

    function random(a, b) {
        let h = (
            Math.imul(a, 374761393) +
            Math.imul(b, 668265263)
        ) | 0;

        h = Math.imul(h ^ (h >>> 13), 1274126177);

        return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    }

    const a = random(ix, iz);
    const b = random(ix + 1, iz);
    const c = random(ix, iz + 1);
    const d = random(ix + 1, iz + 1);

    const top = a + (b - a) * fx;
    const bottom = c + (d - c) * fx;

    return top + (bottom - top) * fz;
}

function grassPatch(x, z) {

    // Broad colour regions.
    const large = grassNoise(x, z, 1100);

    // Smaller variations soften their shapes.
    const detail = grassNoise(x, z, 350);

    return large * 0.75 + detail * 0.25;
}

function generateTerrain(chunkX, chunkZ) {

    const size = 40;
    const spacing = 20;

    let vertices = [];
    let indices = [];
    let textureCoordinates = [];

    // Generate all the vertices.

    for (let z = 0; z <= size; z++) {
        for (let x = 0; x <= size; x++) {

            let worldX = chunkX * size * spacing +
             (x - size / 2) * spacing;

            let worldZ = chunkZ * size * spacing +
             (z - size / 2) * spacing;

            let height = terrainHeight(worldX, worldZ); 
                    
            vertices.push(worldX, height, worldZ);

            const patch = grassPatch(worldX, worldZ);

            textureCoordinates.push(patch, 0);
        }
    }

    // Join the vertices together into triangles.
    for (let z = 0; z < size; z++) {
        for (let x = 0; x < size; x++) {

            let a = z * (size + 1) + x;
            let b = a + 1;
            let c = a + size + 1;
            let d = c + 1;

            indices.push(a, c, b);
            indices.push(b, c, d);
        }
    }

    const normals = [];

    for (let z = 0; z <= size; z++) {
        for (let x = 0; x <= size; x++) {

            const worldX = chunkX * size * spacing +
                          (x - size / 2) * spacing;

            const worldZ = chunkZ * size * spacing +
                          (z - size / 2) * spacing;

            const nx =
                terrainHeight(worldX - spacing, worldZ) -
                terrainHeight(worldX + spacing, worldZ);

            const nz =
                terrainHeight(worldX, worldZ - spacing) -
                terrainHeight(worldX, worldZ + spacing);

            const ny = 2 * spacing;
            const length = Math.hypot(nx, ny, nz);

            normals.push(
                nx / length,
                ny / length,
                nz / length
            );
        }
    }

    return { vertices, indices, textureCoordinates, normals };
}

function generateBuffers(data,data_type) {
  let buffer_object = gl.createBuffer();

  if (data_type == "ARRAY_BUFFER") {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer_object);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  }
  else {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer_object);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(data), gl.STATIC_DRAW);
  }
  return buffer_object;
}

function UpdateStats() {
  document.getElementById("fps").value = fps;
}

function initWebGL() {

  gl = null;

  try {

    gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
      desynchronized: true,
    });

  }
  catch(e) {
  }

  if (!gl) {
    alert("Unable to initialize WebGL. Your browser may not support it.");
  }
}

function getShader(gl, id) {
  let shaderScript = document.getElementById(id);

  if (!shaderScript) {
    return null;
  }

  let theSource = "";
  let currentChild = shaderScript.firstChild;

  while(currentChild) {
    if (currentChild.nodeType == 3) {
      theSource += currentChild.textContent;
    }

    currentChild = currentChild.nextSibling;
  }

  let shader;

  if (shaderScript.type == "x-shader/x-fragment") {
    shader = gl.createShader(gl.FRAGMENT_SHADER);
  } else if (shaderScript.type == "x-shader/x-vertex") {
    shader = gl.createShader(gl.VERTEX_SHADER);
  } else {
    return null;
  }

  gl.shaderSource(shader, theSource);

  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    alert("An error occurred compiling the shaders: " + gl.getShaderInfoLog(shader));
    return null;
  }

  return shader;
}

function initShaders() {
  let fragmentShader = getShader(gl, "shader-fs");
  let vertexShader = getShader(gl, "shader-vs");

  shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vertexShader);
  gl.attachShader(shaderProgram, fragmentShader);
  gl.linkProgram(shaderProgram);

  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    alert("Unable to initialize the shader program.");
  }

  gl.useProgram(shaderProgram);

  vertexPositionAttribute = gl.getAttribLocation(shaderProgram, "aVertexPosition");
    gl.enableVertexAttribArray(vertexPositionAttribute);

  textureCoordAttribute = gl.getAttribLocation(shaderProgram, "aTextureCoord");
    gl.enableVertexAttribArray(textureCoordAttribute);

  vertexNormalAttribute =
    gl.getAttribLocation(shaderProgram, "aVertexNormal");

  gl.enableVertexAttribArray(vertexNormalAttribute);

}

