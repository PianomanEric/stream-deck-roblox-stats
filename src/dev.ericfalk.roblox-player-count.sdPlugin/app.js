/// <reference path="libs/js/action.js" />
/// <reference path="libs/js/stream-deck.js" />

const ICON_SIZE = 144;
const FONT_NAME = "Bebas Neue";

const playerCount = new Action('dev.ericfalk.roblox-player-count.action');

const activeKeys = new Map();

function refreshKeys() {
	if (activeKeys.size === 0) {
		return;
	}

	const gamesList = [];

	for (let gameId of activeKeys.values()) {
		if (!gamesList.includes(gameId)) {
			gamesList.push(gameId);
		}
	}

	Promise.all([
		fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${gamesList.join(',')}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`)
		.then((response) => {
			return response.json();
		})
		.then(async (json) => {
			const iconRequests = [];
			const icons = new Map();
			for (let iconData of json.data) {
				iconRequests.push(
					fetch(iconData.imageUrl)
					.then((response) => {
						return response.blob();
					})
					.then(async (blob) => {
						const reader = new FileReader();
						reader.readAsDataURL(blob);
						return await new Promise((resolve, reject) => {
							reader.onloadend = () => {
								resolve(reader.result);
							};
						})
					})
					.then((icon) => {
						icons.set(iconData.targetId, icon);
					})
				);
			}
			await Promise.all(iconRequests);
			return icons;
		}),

		fetch(`https://games.roblox.com/v1/games?universeIds=${gamesList}`)
		.then((response) => {
			return response.json();
		})
		.then((json) => {
			const playerCounts = new Map();
			for (let gameData of json.data) {
				playerCounts.set(gameData.id, gameData.playing.toLocaleString());
			}
			return playerCounts;
		})
	]).then(async ([icons, playerCounts]) => {
		const keyImages = new Map();
		for (let [gameId, icon] of icons) {
			const newImage = await addTextToImage(icon, playerCounts.get(gameId));
			keyImages.set(gameId, newImage);
		}
		return keyImages;
	}).then((keyImages) => {
		for (let [context, gameId] of activeKeys.entries()) {
			$SD.setImage(context, keyImages.get(gameId)); // ADD AN ALTERNATE IMAGE, ERROR
		}
	});
}

function updateKeyPlace(context, placeId) {
	return fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)
	.then((response) => {
		return response.json();
	})
	.then((json) => {
		return parseInt(json.universeId || 0);
	})
	.then((universeId) => {
		activeKeys.set(context, parseInt(universeId));
	})
	.catch(() => {
		activeKeys.set(context, 0);
	});
}

function addTextToImage(base64, text) {
	const image = new Image();
	const canvas = document.createElement("canvas");

	return new Promise((resolve, reject) => {
		image.onload = function() {
			canvas.width = ICON_SIZE;
			canvas.height = ICON_SIZE;
			const ctx = canvas.getContext("2d");
			ctx.filter = `blur(${1.5}px) brightness(50%)`;
			ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

			ctx.filter = "none";
			//ICON_SIZE/4
			ctx.font = `${50}px '${FONT_NAME}'`;
			ctx.fillStyle = "white";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.shadowColor = "black";
      		ctx.shadowBlur = 4;
			ctx.strokeStyle = "black";
			ctx.strokeText(text, canvas.width/2, canvas.height/2);
			ctx.fillText(text, canvas.width/2, canvas.height/2);
			const base64Result = canvas.toDataURL('image/jpeg');
			resolve(base64Result);
		}

		image.src = base64;
	})
}

playerCount.onWillAppear(({ action, context, device, event, payload }) => {
	if (activeKeys.size === 0) {
		setInterval(refreshKeys, 30000);
	}
	updateKeyPlace(context, payload.settings.placeId).then(() => {
		refreshKeys();
	});
});

playerCount.onWillDisappear(({ action, context, device, event, payload }) => {
	activeKeys.delete(context);
	if (activeKeys.size === 0) {
		clearInterval(refreshKeys);
	}
});

playerCount.onDidReceiveSettings(({ action, context, device, event, payload }) => {
	updateKeyPlace(context, payload.settings.placeId).then(() => {
		refreshKeys();
	});
});

document.fonts.ready.then(() => {
	refreshKeys();
})