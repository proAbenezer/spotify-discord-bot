const SpotifyWebApi = require("spotify-web-api-node");
const express = require("express");
require("dotenv").config();
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  Partials,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  UserContextMenuCommandInteraction,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI,
});

const app = express();

// This is a temporary solution for storing access tokens, will use a database in the future
let userTokens = {};

function readAccessToken() {
  if (fs.existsSync("./token.json")) {
    try {
      const data = fs.readFileSync("./token.json", "utf-8");
      if (!data) {
        return {};
      }
      return JSON.parse(data);
    } catch (error) {
      console.error("Error reading or parsing token file:", error);
      return {};
    }
  }
  return {};
}
function writeAccessToken() {
  try {
    fs.writeFileSync("./token.json", JSON.stringify(userTokens, null, 2));
  } catch (error) {
    console.error("Error writing token file:", error);
  }
}

async function refreshAccessToken(userId) {
  try {
    spotifyApi.setAccessToken(userTokens[userId].accessToken);
    await spotifyApi.getMe();
  } catch (error) {
    if (error.statusCode === 401) {
      console.log("Access token expired, refreshing...");
      try {
        spotifyApi.setRefreshToken(userTokens[userId].refreshToken);
        const data = await spotifyApi.refreshAccessToken();
        console.log("Refresh response:", data.body.access_token);

        const newAccessToken = data.body["access_token"];
        const newRefreshToken = data.body["refresh_token"];

        userTokens[userId].accessToken = newAccessToken;
        if (newRefreshToken) {
          userTokens[userId].refreshToken = newRefreshToken;
        }

        writeAccessToken();
        spotifyApi.setAccessToken(newAccessToken);
        console.log("Access token refreshed successfully");
      } catch (refreshErr) {
        if (refreshErr.body && refreshErr.body.error === "invalid_grant") {
          console.error(
            "Refresh token revoked, user needs to reauthenticate:",
            refreshErr
          );
          delete userTokens[userId];
          writeAccessToken();
          const authUrl = await spotifyApi.createAuthorizeURL(
            ["user-top-read"],
            userId
          );
          client.users.cache
            .get(userId)
            .send(
              `Your Spotify session has expired. Please reauthenticate by clicking [here](${authUrl}).`
            );
        } else {
          console.error("Error refreshing access token:", refreshErr);
        }
      }
    }
  }
}

userTokens = readAccessToken();
app.get("/callback", (req, res) => {
  const code = req.query.code;
  spotifyApi
    .authorizationCodeGrant(code)
    .then((data) => {
      const accessToken = data.body["access_token"];
      const refreshToken = data.body["refresh_token"];
      userTokens[req.query.state] = { accessToken, refreshToken };
      writeAccessToken();
      console.log("signed successfully");
      res.send("Successfully authenticated. You can close this window.");
    })
    .catch((err) => {
      console.error("Error during authorization:", err);
      res.send("Failed to authenticate.");
    });
});

app.listen(process.env.PORT, () => {
  console.log("Express server running on port " + process.env.PORT);
});

client.once("ready", () => {
  console.log("Connected to discord as " + client.user.tag);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content.startsWith("!topartists")) {
    if (!userTokens[message.author.id]) {
      const authUrl = await spotifyApi.createAuthorizeURL(
        ["user-top-read"],
        message.author.id
      );
      message.author.send(
        `Please authorize the bot by clicking [here](${authUrl}) \nPs: This bot's commands work in DMs too!`
      );
      message.channel.send(
        "Please link your Spotify account by clicking the link sent to your DMs."
      );
    } else {
      await refreshAccessToken(message.author.id);
      spotifyApi.setAccessToken(userTokens[message.author.id].accessToken);
      spotifyApi.setRefreshToken(userTokens[message.author.id].refreshToken);

      handleAuthenticatedUser(message);
    }
  }
});

async function handleAuthenticatedUser(message) {
  let topArtists = [];
  try {
    const data = await spotifyApi.getMyTopArtists({ limit: 10 });
    console.log(data.headers);
    topArtists = data.body.items;
    let options = `Choose from the following artists\n${message.author}, here are your top artists:\n`;

    topArtists.forEach((artist, index) => {
      options += `${index + 1}. ${artist.name}\n`;
    });

    message.channel.send(options);
  } catch (err) {
    console.error("Error fetching top artists:", err);
    message.channel.send("Failed to fetch top artists.");
  }

  getUserQuery(message, topArtists);
}

async function getUserQuery(message, topArtists) {
  try {
    let trackObjectsArr = [];

    const clipSelection = await waitForUserResponse(message);
    const selectedClipIndex = parseInt(clipSelection.content) - 1;
    const selectedArtists = topArtists[selectedClipIndex];

    trackObjectsArr = await getRandomTracks(selectedArtists.id);

    let files = [];
    let correctCustomId = "";
    let correctName = "";
    const labels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const row = new ActionRowBuilder();

    trackObjectsArr.map(async (trackObject, index) => {
      if (trackObject.isCorrect) {
        correctCustomId = `option ${labels[index]}`;
        correctName = trackObject.track.name;
        files = [
          {
            attachment: `${trackObject.track.preview_url}.mp3`,
            name: "preview.mp3",
          },
        ];
      }
    });

    trackObjectsArr.map((trackObject, index) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`option ${labels[index]}`)
          .setLabel(`${labels[index]}. ${trackObject.track.name}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });

    const response = await message.channel.send({
      content: `choose the correct name of the clip\n${message.author}`,
      components: [row],
      files: files,
    });

    try {
      const confirmation = await response.awaitMessageComponent({
        filter: (_) => true,
        time: 60_000,
      });
      if (confirmation.customId === correctCustomId) {
        confirmation.update({ components: [] });
        await message.channel.send(
          `Correct! The correct name of the clip is ${correctName}`
        );
      } else {
        await confirmation.update({ components: [] });
        await message.channel.send(
          `Wrong! The correct name of the clip is ${correctName}`
        );
      }
    } catch (e) {
      console.log(e);
      await response.edit({
        content: "You took too long to respond!",
        components: [],
      });
    }
  } catch (err) {
    console.log(`ERROR collecting the tracks object ${err}`);
    message.channel.send("ERROR collecting the tracks Please try again");
  }
}
function waitForUserResponse(message) {
  return new Promise((resolve) => {
    const filter = (response) => response.author.id === message.author.id;
    message.channel
      .awaitMessages({ filter, max: 1, time: 60000, errors: ["time"] })
      .then((collected) => resolve(collected.first()))
      .catch(() => {
        message.channel.send("You took too long to respond. Please try again.");
        resolve(null);
      });
  });
}

async function getRandomTracks(id) {
  try {
    let albums = await fetchAlbums(id);
    if (albums && albums.length > 0) {
      let albumList = [];
      albums.forEach((album) => {
        albumList.push(album.id);
      });
      let fetchedAlbums = (await spotifyApi.getAlbums(albumList)).body.albums;
      let tracks = [];
      fetchedAlbums.forEach((album) => {
        album.tracks.items.forEach((track) => {
          tracks.push(track);
        });
      });

      return tracks
        .filter((track) => track.preview_url !== null)
        .sort(() => Math.random() - 0.5)
        .slice(0, 4)
        .map((track, index) => ({ track: track, isCorrect: index === 0 }))
        .sort(() => Math.random() - 0.5);
    }
  } catch (err) {
    console.log(`ERROR failed fetching the tracks: ${err}`);
    return;
  }
}
async function fetchAlbums(id) {
  try {
    const data = await spotifyApi.getArtistAlbums(id, { limit: 20 });
    const albums = data.body.items;
    if (albums.length === 0) {
      console.log("No album found for this particular artist.");
    }
    return albums;
  } catch (error) {
    console.log(`ERROR fetching the albums: ${error}`);
    return null;
  }
}

client.login(process.env.DISCORD_BOT_TOKEN);
