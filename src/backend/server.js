import dotenv from "dotenv";
import multer from "multer";
import Express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import bodyParser from "body-parser";
import { v2 as cloudinary } from "cloudinary";

dotenv.config();

const app = Express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
const client = new MongoClient(process.env.CONNECTION_STRING);
const upload = multer({ storage: multer.memoryStorage() });
let database, collection;
let server;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET_KEY,
});

async function startServer() {
  try {
    await client.connect();
    database = client.db("cocktailapp");
    collection = database.collection("cocktails");
    server = app.listen(port, () => {
      console.log(`Server started on port ${port}`);
    });
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  }
}

startServer();

async function shutdown(code = 0) {
  console.log("Shutting down...");
  try {
    if (server && typeof server.close === "function") {
      // stop accepting new connections
      await new Promise((resolve) => server.close(resolve));
      console.log("HTTP server closed.");
    }
    if (client && client.isConnected && client.isConnected()) {
      await client.close();
      console.log("MongoDB connection closed.");
    } else if (client) {
      // in recent drivers, isConnected may not exist; attempt close anyway
      try {
        await client.close();
      } catch (e) {
        console.error("Error closing MongoDB client:", e);
      }
    }
  } catch (err) {
    console.error("Error during shutdown:", err);
  } finally {
    process.exit(code);
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  shutdown(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  shutdown(1);
});

/**
 * --------------------- API END POINTS ---------------------
 */

app.get("/api/get-items", async (req, res) => {
  try {
    const pagination = Number(req.query.pagination) || 0;
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const filters = req.query.filters; // stringified JSON expected by getItems

    const response = await getItems(pagination, limit, filters);
    res.json(response);
  } catch (err) {
    console.error("GET /api/get-items error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const pagination = Number(req.query.pagination) || 0;
    const limit = Math.min(Number(req.query.limit) || 10, 20);
    const search = String(req.query.search || "");

    if (!search) {
      return res.status(400).json({ error: "Missing search parameter" });
    }

    const response = await getItemsByName(pagination, limit, search);
    res.json(response);
  } catch (err) {
    console.error("GET /api/search error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/add", async (req, res) => {
  try {
    const data = req.body;

    if (!data || Object.keys(data).length === 0) {
      return res.status(400).json({ error: "Missing body" });
    }

    const response = await add(req.body);
    res.status(201).json(response);
  } catch (err) {
    console.error("POST /api/add error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          { resource_type: "image", folder: "drinks" },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        )
        .end(req.file.buffer);
    });

    res.json({ url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Image upload failed", message: err.message });
  }
});

app.put("/api/edit", async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data._id) {
      return res.status(400).json({ error: "Missing id in body" });
    }

    await edit(req.body);

    res.json({ message: "Item updated successfully" });
  } catch (err) {
    console.error("PUT /api/edit error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/edit-image", upload.single("image"), async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            public_id: req.body.public_id,
            resource_type: "image",
            overwrite: true,
            invalidate: true,
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        )
        .end(req.file.buffer);
    });

    res.json({ message: "Image updated successfully" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Image upload failed", message: err.message });
  }
});

app.delete("/api/delete", async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.id) {
      return res.status(400).json({ error: "Missing id in body" });
    }

    const response = await remove(req.body);
    res.json(response);
  } catch (err) {
    console.error("DELETE /api/delete error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/delete-image", async (req, res) => {
  try {
    const { public_id } = req.body;
    if (!public_id) {
      return res.status(400).json({ error: "Missing public_id in body" });
    }

    const result = await cloudinary.uploader.destroy(public_id);

    res.json(result);
  } catch (err) {
    console.error("DELETE /api/delete-image error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * --------------------- METHODS ---------------------
 */

async function getItems(pagination, limit = 10, filters) {
  let isEndOfCollection = false;

  try {
    let preparedFilters = {};

    if (filters) {
      try {
        const filtersObject = JSON.parse(filters);

        Object.values(filtersObject).forEach((filter) => {
          preparedFilters[filter.filterName] = { $in: filter.filterValues };
        });
      } catch (err) {
        console.error(`Failed to parse filters: ${err}\n`);
        throw err;
      }
    }

    const items = await collection
      .find(preparedFilters)
      .skip(Number(pagination))
      .limit(Number(limit))
      .toArray();

    if (items.length < limit) {
      isEndOfCollection = true;
    }

    return { items, isEndOfCollection };
  } catch (err) {
    console.error(`Something went wrong trying to get documents: ${err}\n`);
    throw err;
  }
}

async function getItemsByName(pagination, limit = 10, search) {
  let isEndOfCollection = false;

  try {
    const items = await collection
      .find({
        $text: {
          $search: search,
        },
      })
      .skip(Number(pagination))
      .limit(Number(limit))
      .toArray();

    if (items.length < limit) {
      isEndOfCollection = true;
    }

    return { items, isEndOfCollection };
  } catch (err) {
    console.error(
      `Something went wrong trying to get documents by phrase ${search}: ${err}\n`
    );
    throw err;
  }
}

async function add(data) {
  try {
    const insertedItem = await collection.insertOne(data);
    return insertedItem;
  } catch (err) {
    console.error(
      `Something went wrong trying to insert the new document: ${err}\n`
    );
    throw err;
  }
}

async function edit(data) {
  try {
    if (!ObjectId.isValid(String(data._id))) {
      throw new Error("Invalid id");
    }

    const preparedData = { ...data };
    delete preparedData._id;

    await collection.updateOne(
      { _id: new ObjectId(`${data._id}`) },
      { $set: preparedData }
    );
  } catch (err) {
    console.error(`Something went wrong trying to update document: ${err}\n`);
    throw err;
  }
}

async function remove(data) {
  try {
    if (!ObjectId.isValid(String(data.id))) {
      throw new Error("Invalid id");
    }

    const query = { _id: new ObjectId(`${data.id}`) };
    const deletedItem = await collection.deleteOne(query);
    return deletedItem;
  } catch (err) {
    console.error(
      `Something went wrong trying to delete the document: ${err}\n`
    );
    throw err;
  }
}
