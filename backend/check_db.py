import psycopg2

def check(user, password, port, dbname):
    try:
        conn = psycopg2.connect(
            user=user, 
            password=password, 
            host="localhost", 
            port=port, 
            dbname=dbname
        )
        print(f"SUCCESS: {user}:{password}@{port}/{dbname}")
        conn.close()
    except Exception as e:
        # Just grab the error msg
        err = str(e).strip().replace('\n', ' ')
        print(f"FAILED: {user}:{password}@{port}/{dbname} -> {err}")

if __name__ == "__main__":
    print("Checking database connections...")
    # Expected config
    check("vendora", "vendora", 5436, "vendora")
    
    # Defaults just in case
    check("postgres", "postgres", 5436, "postgres")
    check("postgres", "password", 5436, "postgres")
    check("postgres", "vendora", 5436, "postgres")
    check("postgres", "vendora", 5436, "vendora")
