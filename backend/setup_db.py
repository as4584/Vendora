import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

def create_database():
    try:
        # Connect to default database 'postgres' to create new db
        conn = psycopg2.connect(
            user="postgres",
            password="password",  # Trying 'password' first as common default
            host="localhost",
            port="5432",
            dbname="postgres" 
        )
        conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cur = conn.cursor()
        
        # Check if database exists
        cur.execute("SELECT 1 FROM pg_database WHERE datname = 'vendora'")
        exists = cur.fetchone()
        
        if not exists:
            print("Creating database 'vendora'...")
            cur.execute('CREATE DATABASE vendora')
            print("Database created successfully.")
        else:
            print("Database 'vendora' already exists.")
            
        cur.close()
        conn.close()

    except psycopg2.OperationalError as e:
        # Try 'postgres' password if 'password' fails
        if "password authentication failed" in str(e):
             try:
                print("Trying password 'postgres'...")
                conn = psycopg2.connect(
                    user="postgres",
                    password="postgres", 
                    host="localhost",
                    port="5432",
                    dbname="postgres"
                )
                conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
                cur = conn.cursor()
                cur.execute("SELECT 1 FROM pg_database WHERE datname = 'vendora'")
                if not cur.fetchone():
                    print("Creating database 'vendora'...")
                    cur.execute('CREATE DATABASE vendora')
                    print("Database created successfully.")
                else:
                    print("Database 'vendora' already exists.")
                cur.close()
                conn.close()
             except Exception as inner_e:
                print(f"Failed to connect using 'postgres' password: {inner_e}")
        else:
            print(f"Connection error: {e}")

if __name__ == "__main__":
    create_database()
