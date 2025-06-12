import { action, KeyAction, DialAction, DidReceiveSettingsEvent, KeyDownEvent, SingletonAction, streamDeck, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { Jimp, loadFont, measureText, measureTextHeight } from "jimp";

const REFRESH_INTERVAL = 30000;

interface UniverseResponse {
	universeId: string
}

interface ThumbnailData {
	imageUrl: string,
	targetId: string,
}

interface UniverseData {
	id: string,
	playing: string,
}

interface ThumbnailResponse {
	data: [ThumbnailData]
}

interface UniverseDataResponse {
	data: [UniverseData]
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let activeActions: Set<string> = new Set<string>();

function shortenNumber(num: number = 0) {
	if (num < 1000) {
		return String(num)
	}
	const characters = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', '?'];
	let group = Math.floor(Math.log10(num)/3);
	let divisor = 1000**group/10;
	let rounded = Math.round(num/divisor)/10
	if (rounded == 1000) {
		rounded /= 1000;
		group += 1;
	}
	return rounded + characters[Math.min(group, characters.length-1)];
}

function registerAction(actionId: string) {
	activeActions.add(actionId);
	if (activeActions.size > 0 && intervalId === null) {
		intervalId = setInterval(() => {
			let actions: (KeyAction | DialAction)[] = [];
			activeActions.forEach((actionId) => {
				let action = streamDeck.actions.getActionById(actionId);
				if (action) {
					actions.push(action);
				}
			});
			updateActions(actions);
		}, REFRESH_INTERVAL);
	}
}

function unregisterAction(actionId: string) {
	activeActions.delete(actionId);
	if (activeActions.size === 0 && intervalId !== null) {
		clearInterval(intervalId);
		intervalId = null
	}
}

let cachedSettings: Map<string, CountSettings> = new Map<string, CountSettings>();

function getSettings(actionId: string): CountSettings {
	return cachedSettings.get(actionId) || {
		placeId: 0,
		format: "compact",
	} as CountSettings
}

async function updateActions(actions: (KeyAction | DialAction)[]) {
	let universeMap: Map<number, (KeyAction | DialAction)[]> = new Map(); 
	await Promise.all(actions.map(async (action: KeyAction | DialAction) => {
		const settings: CountSettings = getSettings(action.id)
		const universe = await getUniverseFromPlace(settings.placeId || 0);
		let actions = universeMap.get(universe) || [];
		actions.push(action);
		universeMap.set(universe, actions);
	}));
	const universes = Array.from(universeMap.keys());
	const sterilizedUniverses: number[] = universes.filter((universe) => universe !== 0);
	await Promise.all([
		getThumbnails(sterilizedUniverses),
		getPlayerCounts(sterilizedUniverses),
	]).then(async ([thumbnails, counts]) => {
		await Promise.all(sterilizedUniverses.map(async (universeId) => {
			let actions = universeMap.get(universeId) || [];
			let generatedImages: Map<string, string> = new Map<string, string>();
			await Promise.all(actions.map(async (action) => {
				const settings: CountSettings = getSettings(action.id);
				const format: string = settings.format;
				let image = generatedImages.get(format);
				if (!image) {
					const num = counts.get(universeId) || 0
					const numberString: string = (format == "full" ? num.toLocaleString() : shortenNumber(num));
					image = await addTextToImage(thumbnails.get(universeId) || "", numberString);
					generatedImages.set(format, image);
				}
				action.setImage(image);
			}));
		}));
		let blankActions = universeMap.get(0);
		if (blankActions) {
			blankActions.forEach((action) => {
				action.setImage("imgs/actions/player-count/icon");
			});
		}
	});
}

async function addTextToImage(base64: string, text: string): Promise<string> {
	const uri = base64.split(";base64,").pop() || "";
	const buffer = Buffer.from(uri, 'base64');
	const image = (await Jimp.read(buffer))
	.resize({w: 144, h: 144}).brightness(0.75);

	if (text == "") {
		text = " "
	}

	// Font created using https://snowb.org/
	let font = await loadFont("./fonts/BebasNeue-Regular.fnt");
	let fontX = measureText(font, text);
	let fontY = measureTextHeight(font, text, Infinity);

	const textImage = new Jimp({
		width: fontX,
		height: fontY,
	})
	.print({
		x: 0,
		y: 0,
		text: {
			text: text,
		},
		font: font,
	})
	.scaleToFit({w: 120, h: 60});

	let x = (image.width - textImage.width) / 2;
	let y = (image.height - textImage.height) / 2;

	const shadowImage = new Jimp({
		height: 144,
		width: 144,
	}).composite(textImage, x, y).brightness(0).blur(5).opacity(0.8);

	image.composite(shadowImage.composite(shadowImage).composite(shadowImage)).composite(textImage, x, y);

	return image.getBase64("image/jpeg");
}

async function getUniverseFromPlace(placeId: number): Promise<number> {
	return fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)
	.then(async (response) => {
		let json = await response.json() as UniverseResponse;
		return parseInt(json.universeId || "0");
	})
	.catch(() => {
		return 0;
	});
}

async function getThumbnails(universeIds: number[]): Promise<Map<number, string>> {
	const thumbnails = new Map();
	if (universeIds.length == 0) {
		return thumbnails;
	}
	return fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.join(',')}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`)
	.then(async (response) => {
		const requests = [];
		if (response.status === 200) {
			let json = await response.json() as ThumbnailResponse;
			for (let thumbnailData of json.data) {
				requests.push(
					fetch(thumbnailData.imageUrl)
					.then(async (response) => {
						let blob = await response.blob();
						let contentType = response.headers.get("Content-Type")
						let buffer = Buffer.from(await blob.arrayBuffer())
						let thumbnail = `data:${contentType};base64,${buffer.toString("base64")}`
						thumbnails.set(parseInt(thumbnailData.targetId), thumbnail);
					})
				);
			}
		}
		await Promise.all(requests);
		return thumbnails;
	});
}

async function getPlayerCounts(universeIds: number[]): Promise<Map<number, number>> {
	const playerCounts: Map<number, number> = new Map<number, number>();
	if (universeIds.length == 0) {
		return playerCounts;
	}
	return fetch(`https://games.roblox.com/v1/games?universeIds=${universeIds}`)
	.then(async (response) => {
		if (response.status === 200) {
			let json = await response.json() as UniverseDataResponse;
			for (let universeData of json.data) {
				playerCounts.set(parseInt(universeData.id), parseInt(universeData.playing));
			}
		}
		return playerCounts;
	});
}

@action({ UUID: "dev.ericfalk.roblox-stats.player-count" })
export class PlayerCount extends SingletonAction<CountSettings> {

	override async onWillAppear(ev: WillAppearEvent<CountSettings>): Promise<void> {
		registerAction(ev.action.id);
		cachedSettings.set(ev.action.id, ev.payload.settings);
		await updateActions([ev.action]);
	}

	override async onWillDisappear(ev: WillDisappearEvent<CountSettings>): Promise<void> {
		unregisterAction(ev.action.id);
		cachedSettings.delete(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<CountSettings>): void {
		let placeId = ev.payload.settings.placeId;
		streamDeck.system.openUrl(`https://www.roblox.com/games/${placeId}/`);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CountSettings>): Promise<void> {
		cachedSettings.set(ev.action.id, ev.payload.settings);
		await updateActions([ev.action]);
	}

}

type CountSettings = {
	placeId?: number;
	format: "compact" | "full";
};
