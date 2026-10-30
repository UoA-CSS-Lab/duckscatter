#!/usr/bin/env python3
"""
Generate label.geojson from output.parquet using DBSCAN clustering and OpenAI API.

Usage:
    cd examples/react
    export OPENAI_API_KEY="your-api-key"
    python scripts/generate_labels.py

Output:
    public/label.geojson
"""

import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
from openai import OpenAI
from sklearn.cluster import DBSCAN
from sklearn.preprocessing import StandardScaler


def find_optimal_eps(X: np.ndarray, target_clusters: int = 40) -> float:
    """
    Find eps value that produces approximately target_clusters clusters.
    Uses binary search to find the optimal eps.
    """
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    eps_min, eps_max = 0.01, 2.0
    best_eps = 0.5
    best_diff = float('inf')

    for _ in range(20):
        eps = (eps_min + eps_max) / 2
        db = DBSCAN(eps=eps, min_samples=5)
        labels = db.fit_predict(X_scaled)
        n_clusters = len(set(labels)) - (1 if -1 in labels else 0)

        diff = abs(n_clusters - target_clusters)
        if diff < best_diff:
            best_diff = diff
            best_eps = eps

        if n_clusters < target_clusters:
            eps_max = eps
        elif n_clusters > target_clusters:
            eps_min = eps
        else:
            break

    return best_eps


def generate_label_with_llm(client: OpenAI, tokens: list[str], model: str = "gpt-4o-mini") -> str:
    """
    Generate a summary label for a cluster using OpenAI API.
    """
    tokens_sample = tokens[:50]
    tokens_str = ", ".join(tokens_sample)

    response = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": "You are a helpful assistant that creates concise labels for word clusters. "
                           "Given a list of related words, output a single short label (1-3 words) that "
                           "best summarizes or categorizes the group. Output only the label, nothing else."
            },
            {
                "role": "user",
                "content": f"Create a short label for this group of words:\n{tokens_str}"
            }
        ],
        max_tokens=20,
        temperature=0.3
    )

    return response.choices[0].message.content.strip()


def main():
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY environment variable is required")

    client = OpenAI(api_key=api_key)

    script_dir = Path(__file__).parent
    parquet_path = script_dir.parent / "public" / "output.parquet"
    output_path = script_dir.parent / "public" / "label.geojson"

    print(f"Reading parquet from: {parquet_path}")
    df = pd.read_parquet(parquet_path)
    print(f"Loaded {len(df)} rows")
    print(f"Columns: {list(df.columns)}")

    X = df[['x', 'y']].values

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    print("Finding optimal eps for ~40 clusters...")
    optimal_eps = find_optimal_eps(X, target_clusters=40)
    print(f"Using eps={optimal_eps:.4f}")

    db = DBSCAN(eps=optimal_eps, min_samples=5)
    df['cluster'] = db.fit_predict(X_scaled)

    n_clusters = len(set(df['cluster'])) - (1 if -1 in df['cluster'].values else 0)
    n_noise = (df['cluster'] == -1).sum()
    print(f"Found {n_clusters} clusters, {n_noise} noise points")

    clustered = df[df['cluster'] != -1]

    features = []
    cluster_ids = sorted(clustered['cluster'].unique())

    for i, cluster_id in enumerate(cluster_ids):
        cluster_data = clustered[clustered['cluster'] == cluster_id]

        centroid_x = cluster_data['x'].mean()
        centroid_y = cluster_data['y'].mean()
        count = len(cluster_data)

        if 'token' in cluster_data.columns:
            tokens = cluster_data['token'].tolist()
            print(f"[{i+1}/{len(cluster_ids)}] Generating label for cluster {cluster_id} ({count} tokens)...")
            label = generate_label_with_llm(client, tokens)
        else:
            label = f"Cluster {cluster_id}"

        print(f"  -> {label}")

        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(centroid_x), float(centroid_y)]
            },
            "properties": {
                "cluster_label": label,
                "cluster": int(cluster_id),
                "count": int(count)
            }
        }
        features.append(feature)

    features.sort(key=lambda f: f['properties']['count'], reverse=True)

    geojson = {
        "type": "FeatureCollection",
        "features": features
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

    print(f"Saved {len(features)} labels to: {output_path}")


if __name__ == "__main__":
    main()
